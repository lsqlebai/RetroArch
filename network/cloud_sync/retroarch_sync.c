/* RetroArch cloud sync gateway driver.
 *
 * Android MVP transport for pkg/emscripten/sync-server.js:
 * - auth: Cookie header captured by Java and stored in SharedPreferences
 * - manifest: JSON array through /manifest
 * - file payloads: JSON/base64 through /file
 */

#include "../cloud_sync_driver.h"

#include <limits.h>
#include <string.h>

#include <encodings/base64.h>
#include <file/file_path.h>
#include <formats/rjson.h>
#include <formats/rjson_helpers.h>
#include <lists/dir_list.h>
#include <lists/file_list.h>
#include <lists/string_list.h>
#include <lrc_hash.h>
#include <net/net_http.h>
#include <streams/file_stream.h>
#include <string/stdstring.h>
#include <compat/strl.h>

#include "../../configuration.h"
#include "../../file_path_special.h"
#include "../../frontend/drivers/platform_unix.h"
#include "../../paths.h"
#include "../../runloop.h"
#include "../../tasks/tasks_internal.h"
#include "../../verbosity.h"

#define RARCH_SYNC_PFX "[retroarch_sync] "
#define RARCH_SYNC_MANIFEST "manifest.server"
#define RARCH_SYNC_UPLOAD_MANIFEST "manifest.upload"

#define RS_FILE_HASH(item_file) ((char*)((item_file) ? ((item_file)->userdata) : (NULL)))
#define RS_FILE_KEY(item_file) ((item_file) ? ((item_file)->alt) : (NULL))

typedef struct
{
   cloud_sync_complete_handler_t cb;
   void *user_data;
   RFILE *rfile;
   char path[PATH_MAX_LENGTH];
   char file[PATH_MAX_LENGTH];
   bool is_manifest;
} retroarch_sync_cb_state_t;

typedef struct
{
   file_list_t *manifest;
   file_list_t *server_manifest;
   file_list_t *updated_manifest;
   uint32_t pending;
   uint32_t uploaded;
   uint32_t skipped;
   uint32_t failed;
   bool manifest_started;
   bool manifest_uploaded;
   bool manifest_changed;
   char manifest_path[PATH_MAX_LENGTH];
} retroarch_sync_upload_state_t;

static bool retroarch_sync_read(const char *path, const char *file,
      cloud_sync_complete_handler_t cb, void *user_data);

static char *retroarch_sync_base_url(void)
{
   char *url = android_get_cloud_sync_server_url();
   settings_t *settings = config_get_ptr();

   if (string_is_empty(url) && !string_is_empty(settings->arrays.webdav_url))
      url = strdup(settings->arrays.webdav_url);

   if (string_is_empty(url))
   {
      free(url);
      return NULL;
   }

   while (url[0] && url[strlen(url) - 1] == '/')
      url[strlen(url) - 1] = '\0';

   return url;
}

static char *retroarch_sync_headers(bool json)
{
   char *cookie = android_get_cloud_sync_cookie_header();
   char *headers;
   size_t len = 0;

   if (string_is_empty(cookie))
   {
      free(cookie);
      return NULL;
   }

   len = strlen(cookie) + (json ? STRLEN_CONST("Content-Type: application/json\r\n") : 0) + 1;
   headers = (char*)calloc(1, len);
   if (!headers)
   {
      free(cookie);
      return NULL;
   }

   strlcpy(headers, cookie, len);
   if (json)
      strlcat(headers, "Content-Type: application/json\r\n", len);

   free(cookie);
   return headers;
}

static char *retroarch_sync_game_id(void)
{
   const char *content_path = path_get(RARCH_PATH_CONTENT);
   char *game_id = NULL;

   if (!string_is_empty(content_path))
      game_id = android_get_cloud_sync_game_id_for_content(content_path);

   if (string_is_empty(game_id))
   {
      free(game_id);
      game_id = android_get_cloud_sync_game_id();
   }

   if (string_is_empty(game_id))
   {
      free(game_id);
      return strdup("default");
   }
   return game_id;
}

static bool retroarch_sync_build_url(
      char *out, size_t out_size, const char *endpoint, const char *rel_path)
{
   bool ok = false;
   char *base = retroarch_sync_base_url();
   char *game_id = retroarch_sync_game_id();
   char *game_enc = NULL;
   char *path_enc = NULL;

   if (string_is_empty(base) || string_is_empty(game_id))
      goto end;

   net_http_urlencode(&game_enc, game_id);
   if (rel_path)
      net_http_urlencode(&path_enc, rel_path);

   if (string_is_equal(endpoint, "manifest"))
      snprintf(out, out_size, "%s/manifest?gameId=%s", base, game_enc);
   else if (path_enc)
      snprintf(out, out_size, "%s/file?gameId=%s&path=%s", base, game_enc, path_enc);
   else
      snprintf(out, out_size, "%s/file?gameId=%s", base, game_enc);

   ok = true;

end:
   free(base);
   free(game_id);
   free(game_enc);
   free(path_enc);
   return ok;
}

static char *retroarch_sync_parse_json_string(const char *json_data,
      size_t len, const char *field)
{
   rjson_t *json;
   char *result = NULL;

   if (!(json = rjson_open_buffer(json_data, len)))
      return NULL;

   for (;;)
   {
      enum rjson_type type = rjson_next(json);
      const char *key;
      size_t key_len = 0;

      if (type == RJSON_DONE || type == RJSON_ERROR)
         break;
      if (type != RJSON_STRING)
         continue;
      if (rjson_get_context_type(json) != RJSON_OBJECT)
         continue;
      if ((rjson_get_context_count(json) & 1) == 0)
         continue;

      key = rjson_get_string(json, &key_len);
      if (     !key
            || key_len != strlen(field)
            || memcmp(key, field, key_len) != 0)
      {
         rjson_next(json);
         continue;
      }

      type = rjson_next(json);
      if (type == RJSON_STRING)
      {
         const char *value;
         size_t value_len = 0;

         value = rjson_get_string(json, &value_len);
         if (value)
         {
            result = (char*)malloc(value_len + 1);
            if (result)
            {
               memcpy(result, value, value_len);
               result[value_len] = '\0';
            }
         }
         break;
      }
   }

   rjson_free(json);
   return result;
}

static char *retroarch_sync_parse_file_data(const char *json_data, size_t len)
{
   return retroarch_sync_parse_json_string(json_data, len, "data");
}

static const char *retroarch_sync_find_header(
      struct string_list *headers, const char *prefix)
{
   size_t i;

   if (!headers || string_is_empty(prefix))
      return NULL;

   for (i = 0; i < headers->size; i++)
   {
      const char *header = headers->elems[i].data;
      if (string_starts_with_case_insensitive(header, prefix))
      {
         const char *value = header + strlen(prefix);
         while (*value == ' ' || *value == '\t')
            value++;
         return value;
      }
   }

   return NULL;
}

static char *retroarch_sync_manifest_fingerprint(const char *data, size_t len)
{
   char digest[65];
   char *hash = (char*)malloc(STRLEN_CONST("sha256:") + sizeof(digest));

   if (!hash || !data)
   {
      free(hash);
      return NULL;
   }

   sha256_hash(digest, (const uint8_t*)data, len);
   snprintf(hash, STRLEN_CONST("sha256:") + sizeof(digest),
         "sha256:%s", digest);

   return hash;
}

static char *retroarch_sync_manifest_entry_count(const char *data, size_t len)
{
   const char needle[] = "\"path\"";
   const size_t needle_len = STRLEN_CONST("\"path\"");
   const char *cursor = data;
   const char *end    = data ? data + len : NULL;
   size_t count       = 0;
   char *entries      = (char*)malloc(32);

   if (!entries || !data)
   {
      free(entries);
      return NULL;
   }

   while (cursor && cursor + needle_len <= end)
   {
      const char *found = strstr(cursor, needle);
      if (!found || found + needle_len > end)
         break;
      count++;
      cursor = found + needle_len;
   }

   snprintf(entries, 32, "%lu", (unsigned long)count);
   return entries;
}

static void retroarch_sync_manifest_display_values(
      http_transfer_data_t *data,
      const char **version, const char **entries,
      char **fallback_version, char **fallback_entries)
{
   if (!data || !data->data)
      return;

   if (string_is_empty(*version))
   {
      *fallback_version = retroarch_sync_manifest_fingerprint(
            data->data, data->len);
      *version = *fallback_version;
   }

   if (string_is_empty(*entries))
   {
      *fallback_entries = retroarch_sync_manifest_entry_count(
            data->data, data->len);
      *entries = *fallback_entries;
   }
}

static void retroarch_sync_short_version(char *out, size_t out_size,
      const char *version)
{
   size_t len;

   if (string_is_empty(version))
   {
      strlcpy(out, "unknown", out_size);
      return;
   }

   len = strlen(version);
   if (len > 19)
      len = 19;
   strlcpy(out, version, out_size);
   out[len] = '\0';
}

static void retroarch_sync_show_manifest_message(const char *action,
      const char *version, const char *entries)
{
   char msg[256];
   char short_version[32];
   size_t len;

   retroarch_sync_short_version(short_version, sizeof(short_version), version);
   len = snprintf(msg, sizeof(msg), "%s remote %s / %s entries",
         action,
         short_version,
         string_is_empty(entries) ? "unknown" : entries);
   if (len >= sizeof(msg))
      len = strlen(msg);
   runloop_msg_queue_push(msg, len, 1, 240, true, NULL,
         MESSAGE_QUEUE_ICON_DEFAULT, MESSAGE_QUEUE_CATEGORY_INFO);
}

static bool retroarch_sync_is_state_path(const char *path)
{
   return path && string_starts_with(path, "states/")
      && !string_is_equal(path, "states/state-labels.json");
}

static void retroarch_sync_head_hex(char *out, size_t out_size,
      const uint8_t *data, size_t len)
{
   size_t i;
   size_t max_len = MIN(len, (size_t)16);

   if (!out_size)
      return;

   out[0] = '\0';
   if (!data)
      return;

   for (i = 0; i < max_len; i++)
   {
      char part[4];
      snprintf(part, sizeof(part), "%02x", data[i]);
      strlcat(out, part, out_size);
      if (i + 1 < max_len)
         strlcat(out, " ", out_size);
   }
}

static void retroarch_sync_log_state_bytes(const char *scope,
      const char *path, const uint8_t *data, size_t len, const char *hash)
{
   char head[64];
   char magic[9];
   size_t i;
   size_t magic_len = MIN(len, (size_t)8);

   if (!retroarch_sync_is_state_path(path))
      return;

   retroarch_sync_head_hex(head, sizeof(head), data, len);
   memset(magic, 0, sizeof(magic));
   for (i = 0; data && i < magic_len; i++)
      magic[i] = data[i] >= 32 && data[i] <= 126 ? (char)data[i] : '.';

   RARCH_LOG(RARCH_SYNC_PFX "[state] %s path=%s size=%lu md5=%s head16=%s magic=\"%s\".\n",
         scope,
         string_is_empty(path) ? "<unknown>" : path,
         (unsigned long)len,
         string_is_empty(hash) ? "unknown" : hash,
         head,
         magic);
}

static void retroarch_sync_log_state_rfile(const char *scope,
      const char *path, RFILE *file, const char *hash)
{
   uint8_t head_bytes[16];
   int64_t pos;
   int64_t size;
   int64_t read_len;

   if (!file || !retroarch_sync_is_state_path(path))
      return;

   size = filestream_get_size(file);
   pos = filestream_tell(file);
   filestream_seek(file, 0, SEEK_SET);
   read_len = filestream_read(file, head_bytes, sizeof(head_bytes));
   filestream_seek(file, pos, SEEK_SET);

   retroarch_sync_log_state_bytes(scope, path, head_bytes,
         read_len > 0 ? (size_t)read_len : 0, hash);
   RARCH_LOG(RARCH_SYNC_PFX "[state] %s full-size path=%s size=%lu md5=%s.\n",
         scope,
         path,
         size > 0 ? (unsigned long)size : 0,
         string_is_empty(hash) ? "unknown" : hash);
}

static void retroarch_sync_log_option_file(const char *scope,
      const char *path)
{
   void *data = NULL;
   int64_t len = 0;
   char *hash = NULL;
   char *text = NULL;
   char savestate[64];
   char mouse_speed[64];
   char mouse_input[64];

   if (string_is_empty(path))
      return;

   if (!filestream_read_file(path, &data, &len) || !data || len <= 0)
   {
      RARCH_LOG(RARCH_SYNC_PFX "[state-options] %s path=%s missing.\n",
            scope, path);
      free(data);
      return;
   }

   hash = retroarch_sync_manifest_fingerprint((const char*)data, (size_t)len);
   text = (char*)calloc(1, (size_t)len + 1);
   if (text)
      memcpy(text, data, (size_t)len);

   strlcpy(savestate, "missing", sizeof(savestate));
   strlcpy(mouse_speed, "missing", sizeof(mouse_speed));
   strlcpy(mouse_input, "missing", sizeof(mouse_input));

   if (text)
   {
      char *line;
      char *saveptr = NULL;
      for (line = strtok_r(text, "\r\n", &saveptr);
            line;
            line = strtok_r(NULL, "\r\n", &saveptr))
      {
         char *value = strchr(line, '=');
         if (!value)
            continue;
         value++;
         while (*value == ' ' || *value == '\t' || *value == '"')
            value++;
         if (string_starts_with(line, "dosbox_pure_savestate"))
         {
            strlcpy(savestate, value, sizeof(savestate));
            if (strchr(savestate, '"'))
               *strchr(savestate, '"') = '\0';
         }
         else if (string_starts_with(line, "dosbox_pure_mouse_speed_factor"))
         {
            strlcpy(mouse_speed, value, sizeof(mouse_speed));
            if (strchr(mouse_speed, '"'))
               *strchr(mouse_speed, '"') = '\0';
         }
         else if (string_starts_with(line, "dosbox_pure_mouse_input"))
         {
            strlcpy(mouse_input, value, sizeof(mouse_input));
            if (strchr(mouse_input, '"'))
               *strchr(mouse_input, '"') = '\0';
         }
      }
   }

   RARCH_LOG(RARCH_SYNC_PFX "[state-options] %s path=%s size=%lu sha256=%s dosbox_pure_savestate=\"%s\" mouse_speed_factor=\"%s\" mouse_input=\"%s\".\n",
         scope,
         path,
         (unsigned long)len,
         string_is_empty(hash) ? "unknown" : hash,
         savestate,
         mouse_speed,
         mouse_input);

   free(text);
   free(hash);
   free(data);
}

static void retroarch_sync_log_options_snapshot(const char *scope)
{
   char config_dir[DIR_MAX_LENGTH];
   char dosbox_opt[PATH_MAX_LENGTH];
   settings_t *settings = config_get_ptr();

   if (settings)
      retroarch_sync_log_option_file(scope, settings->paths.path_core_options);

   fill_pathname_application_special(config_dir,
         sizeof(config_dir), APPLICATION_SPECIAL_DIRECTORY_CONFIG);
   fill_pathname_join_special(dosbox_opt, config_dir,
         "DOSBox-pure/DOSBox-pure.opt", sizeof(dosbox_opt));
   retroarch_sync_log_option_file(scope, dosbox_opt);
}

static bool retroarch_sync_manifest_member(void *ctx,
      const char *s, size_t len)
{
   file_list_t      *list = (file_list_t*)ctx;
   struct item_file *item = &list->list[list->size - 1];

   if (string_is_equal(s, "path"))
      item->type = 1;
   else if (string_is_equal(s, "hash"))
      item->type = 2;
   else
      item->type = 0;
   return true;
}

static bool retroarch_sync_manifest_string(void *ctx,
      const char *s, size_t len)
{
   file_list_t      *list = (file_list_t*)ctx;
   struct item_file *item = &list->list[list->size - 1];

   if (item->type)
   {
      if (item->type == 1)
         file_list_set_alt_at_offset(list, list->size - 1, s);
      else if (item->type == 2)
         item->userdata = strdup(s);
   }
   return true;
}

static bool retroarch_sync_manifest_start_object(void *ctx)
{
   file_list_t *list = (file_list_t*)ctx;
   file_list_append(list, NULL, NULL, 0, 0, 0);
   return true;
}

static bool retroarch_sync_manifest_end_object(void *ctx)
{
   file_list_t      *list = (file_list_t*)ctx;
   struct item_file *item = &list->list[list->size - 1];

   if (!RS_FILE_KEY(item))
      list->size--;
   else
      item->type = 0;
   return true;
}

static file_list_t *retroarch_sync_manifest_parse(const char *data, size_t len)
{
   file_list_t *list = NULL;
   rjson_t *json     = NULL;

   if (!(list = (file_list_t*)calloc(1, sizeof(*list))))
      return NULL;
   if (!(json = rjson_open_buffer(data, len)))
   {
      free(list);
      return NULL;
   }

   rjson_parse(json, list,
         retroarch_sync_manifest_member,
         retroarch_sync_manifest_string,
         NULL,
         retroarch_sync_manifest_start_object,
         retroarch_sync_manifest_end_object,
         NULL,
         NULL,
         NULL,
         NULL);

   rjson_free(json);
   return list;
}

static struct item_file *retroarch_sync_manifest_find_exact(
      file_list_t *manifest, const char *key)
{
   size_t i;

   if (!manifest || string_is_empty(key))
      return NULL;

   for (i = 0; i < manifest->size; i++)
   {
      struct item_file *item = &manifest->list[i];
      const char *item_key = RS_FILE_KEY(item);
      if (item_key && string_is_equal(item_key, key))
         return item;
   }

   return NULL;
}

static bool retroarch_sync_manifest_set(file_list_t *manifest,
      const char *key, const char *hash)
{
   size_t idx;
   struct item_file *item;

   if (!manifest || string_is_empty(key))
      return false;

   item = retroarch_sync_manifest_find_exact(manifest, key);
   if (!item)
   {
      idx = manifest->size;
      if (!file_list_append(manifest, NULL, NULL, 0, 0, 0))
         return false;
      file_list_set_alt_at_offset(manifest, idx, key);
      item = &manifest->list[idx];
   }

   free(item->userdata);
   item->userdata = hash ? strdup(hash) : NULL;
   return hash == NULL || item->userdata != NULL;
}

static file_list_t *retroarch_sync_manifest_clone(file_list_t *manifest)
{
   size_t i;
   file_list_t *clone = (file_list_t*)calloc(1, sizeof(*clone));

   if (!clone)
      return NULL;

   if (manifest)
   {
      for (i = 0; i < manifest->size; i++)
      {
         struct item_file *item = &manifest->list[i];
         if (!retroarch_sync_manifest_set(clone,
                  RS_FILE_KEY(item), RS_FILE_HASH(item)))
         {
            file_list_free(clone);
            return NULL;
         }
      }
   }

   return clone;
}

static void retroarch_sync_read_cb(retro_task_t *task,
      void *task_data, void *user_data, const char *err)
{
   retroarch_sync_cb_state_t *state = (retroarch_sync_cb_state_t*)user_data;
   http_transfer_data_t *data       = (http_transfer_data_t*)task_data;
   RFILE *file                      = NULL;
   bool success                     = data
      && ((data->status >= 200 && data->status < 300) || data->status == 404);
   bool file_success                = false;

   (void)task;
   (void)err;

   if (!state)
      return;

   if (success && data && data->status != 404 && data->data)
   {
      if (state->is_manifest)
      {
         const char *version = retroarch_sync_find_header(data->headers,
               "X-RetroArch-Cloud-Manifest-Version:");
         const char *entries = retroarch_sync_find_header(data->headers,
               "X-RetroArch-Cloud-Manifest-Entries:");
         const char *updated_at = retroarch_sync_find_header(data->headers,
               "X-RetroArch-Cloud-Manifest-Updated-At:");
         char *fallback_version = NULL;
         char *fallback_entries = NULL;

         retroarch_sync_manifest_display_values(data,
               &version, &entries, &fallback_version, &fallback_entries);

         RARCH_LOG(RARCH_SYNC_PFX "Remote manifest game version=%s entries=%s updatedAt=%s.\n",
               string_is_empty(version) ? "unknown" : version,
               string_is_empty(entries) ? "unknown" : entries,
               string_is_empty(updated_at) ? "unknown" : updated_at);
         retroarch_sync_show_manifest_message("Cloud sync",
               version, entries);

         file = filestream_open(state->file,
               RETRO_VFS_FILE_ACCESS_WRITE,
               RETRO_VFS_FILE_ACCESS_HINT_NONE);
         if (file)
         {
            file_success = filestream_write(file, data->data, data->len)
                  == (int64_t)data->len;
            filestream_seek(file, 0, SEEK_SET);
         }

         free(fallback_version);
         free(fallback_entries);
      }
      else
      {
         char *remote_hash = retroarch_sync_parse_json_string(data->data,
               data->len, "hash");
         char *encoded = retroarch_sync_parse_file_data(data->data, data->len);
         if (encoded)
         {
            int decoded_len = 0;
            unsigned char *decoded = unbase64(encoded, (int)strlen(encoded), &decoded_len);
            if (decoded)
            {
               retroarch_sync_log_state_bytes("download remote",
                     state->path, decoded, decoded_len > 0 ? (size_t)decoded_len : 0,
                     remote_hash);
               file = filestream_open(state->file,
                     RETRO_VFS_FILE_ACCESS_WRITE,
                     RETRO_VFS_FILE_ACCESS_HINT_NONE);
               if (file)
               {
                  file_success = filestream_write(file, decoded, decoded_len)
                        == decoded_len;
                  filestream_seek(file, 0, SEEK_SET);
               }
               if (file_success && retroarch_sync_is_state_path(state->path))
                  retroarch_sync_log_options_snapshot("after state download");
               free(decoded);
            }
            free(encoded);
         }
         RARCH_LOG(RARCH_SYNC_PFX "Downloaded remote file path=%s hash=%s.\n",
               state->path,
               string_is_empty(remote_hash) ? "unknown" : remote_hash);
         free(remote_hash);
      }
   }
   else if (!success && data)
      RARCH_WARN(RARCH_SYNC_PFX "GET %s failed with HTTP %d.\n",
            state->path, data->status);

   if (success && data && data->status != 404 && !file_success)
      success = false;

   state->cb(state->user_data, state->path, success, file);
   free(state);
}

static bool retroarch_sync_read(const char *path, const char *file,
      cloud_sync_complete_handler_t cb, void *user_data)
{
   void *task;
   char url[PATH_MAX_LENGTH];
   char *headers;
   retroarch_sync_cb_state_t *state;
   bool is_manifest = string_is_equal(path, RARCH_SYNC_MANIFEST);

   if (!retroarch_sync_build_url(url, sizeof(url),
            is_manifest ? "manifest" : "file", is_manifest ? NULL : path))
      return false;

   headers = retroarch_sync_headers(false);
   if (!headers)
      return false;

   state = (retroarch_sync_cb_state_t*)calloc(1, sizeof(*state));
   if (!state)
   {
      free(headers);
      return false;
   }

   state->cb          = cb;
   state->user_data   = user_data;
   state->is_manifest = is_manifest;
   strlcpy(state->path, path, sizeof(state->path));
   strlcpy(state->file, file, sizeof(state->file));

   RARCH_LOG(RARCH_SYNC_PFX "GET %s\n", url);
   task = task_push_http_transfer_with_headers(url, true, NULL,
         headers, retroarch_sync_read_cb, state);
   free(headers);

   if (!task)
   {
      free(state);
      return false;
   }
   return true;
}

static char *retroarch_sync_read_rfile(RFILE *rfile, int *len)
{
   int64_t size;
   char *buf;

   *len = 0;
   if (!rfile)
      return NULL;

   size = filestream_get_size(rfile);
   if (size < 0 || size > INT_MAX)
      return NULL;

   buf = (char*)malloc((size_t)size + 1);
   if (!buf)
      return NULL;

   filestream_seek(rfile, 0, SEEK_SET);
   if (filestream_read(rfile, buf, size) != size)
   {
      free(buf);
      return NULL;
   }
   buf[size] = '\0';
   *len = (int)size;
   filestream_seek(rfile, 0, SEEK_SET);
   return buf;
}

static char *retroarch_sync_file_json(const char *path, RFILE *rfile)
{
   int len = 0;
   int b64_len = 0;
   char *data = retroarch_sync_read_rfile(rfile, &len);
   char *encoded;
   char *json = NULL;
   rjsonwriter_t *writer;

   if (!data)
      return NULL;

   encoded = base64(data, len, &b64_len);
   free(data);
   if (!encoded)
      return NULL;

   writer = rjsonwriter_open_memory();
   if (writer)
   {
      rjsonwriter_add_start_object(writer);
      rjsonwriter_add_string(writer, "path");
      rjsonwriter_add_colon(writer);
      rjsonwriter_add_string(writer, path);
      rjsonwriter_add_comma(writer);
      rjsonwriter_add_string(writer, "data");
      rjsonwriter_add_colon(writer);
      rjsonwriter_add_string_len(writer, encoded, b64_len);
      rjsonwriter_add_end_object(writer);
      if (rjsonwriter_get_memory_buffer(writer, NULL))
         json = strdup(rjsonwriter_get_memory_buffer(writer, NULL));
      rjsonwriter_free(writer);
   }

   free(encoded);
   return json;
}

static void retroarch_sync_update_cb(retro_task_t *task,
      void *task_data, void *user_data, const char *err)
{
   retroarch_sync_cb_state_t *state = (retroarch_sync_cb_state_t*)user_data;
   http_transfer_data_t *data       = (http_transfer_data_t*)task_data;
   bool success                     = data && data->status >= 200 && data->status < 300;

   (void)task;
   (void)err;

   if (!state)
      return;

   if (!success && data)
      RARCH_WARN(RARCH_SYNC_PFX "PUT %s failed with HTTP %d.\n",
            state->path, data->status);
   else if (success && data && state->is_manifest)
   {
      const char *version = retroarch_sync_find_header(data->headers,
            "X-RetroArch-Cloud-Manifest-Version:");
      const char *entries = retroarch_sync_find_header(data->headers,
            "X-RetroArch-Cloud-Manifest-Entries:");
      const char *updated_at = retroarch_sync_find_header(data->headers,
            "X-RetroArch-Cloud-Manifest-Updated-At:");
      char *fallback_version = NULL;
      char *fallback_entries = NULL;

      retroarch_sync_manifest_display_values(data,
            &version, &entries, &fallback_version, &fallback_entries);

      RARCH_LOG(RARCH_SYNC_PFX "Updated remote manifest version=%s entries=%s updatedAt=%s.\n",
            string_is_empty(version) ? "unknown" : version,
            string_is_empty(entries) ? "unknown" : entries,
            string_is_empty(updated_at) ? "unknown" : updated_at);
      retroarch_sync_show_manifest_message("Cloud upload",
            version, entries);

      free(fallback_version);
      free(fallback_entries);
   }

   state->cb(state->user_data, state->path, success, state->rfile);
   free(state);
}

static bool retroarch_sync_update(const char *path, RFILE *rfile,
      cloud_sync_complete_handler_t cb, void *user_data)
{
   void *task;
   char url[PATH_MAX_LENGTH];
   char *headers;
   char *body;
   int body_len = 0;
   retroarch_sync_cb_state_t *state;
   bool is_manifest = string_is_equal(path, RARCH_SYNC_MANIFEST);

   if (!retroarch_sync_build_url(url, sizeof(url),
            is_manifest ? "manifest" : "file", NULL))
      return false;

   headers = retroarch_sync_headers(true);
   if (!headers)
      return false;

   body = is_manifest
      ? retroarch_sync_read_rfile(rfile, &body_len)
      : retroarch_sync_file_json(path, rfile);

   if (!body)
   {
      free(headers);
      return false;
   }

   state = (retroarch_sync_cb_state_t*)calloc(1, sizeof(*state));
   if (!state)
   {
      free(headers);
      free(body);
      return false;
   }

   state->cb        = cb;
   state->user_data = user_data;
   state->rfile     = rfile;
   state->is_manifest = is_manifest;
   strlcpy(state->path, path, sizeof(state->path));

   RARCH_LOG(RARCH_SYNC_PFX "PUT %s\n", url);
   task = task_push_http_post_transfer_with_headers(url, body, true, "PUT",
         headers, retroarch_sync_update_cb, state);

   free(headers);
   free(body);

   if (!task)
   {
      free(state);
      return false;
   }
   return true;
}

static void retroarch_sync_delete_cb(retro_task_t *task,
      void *task_data, void *user_data, const char *err)
{
   retroarch_sync_cb_state_t *state = (retroarch_sync_cb_state_t*)user_data;
   http_transfer_data_t *data       = (http_transfer_data_t*)task_data;
   bool success                     = data && data->status >= 200 && data->status < 300;

   (void)task;
   (void)err;

   if (!state)
      return;

   if (!success && data)
      RARCH_WARN(RARCH_SYNC_PFX "DELETE %s failed with HTTP %d.\n",
            state->path, data->status);

   state->cb(state->user_data, state->path, success, NULL);
   free(state);
}

static bool retroarch_sync_delete(const char *path,
      cloud_sync_complete_handler_t cb, void *user_data)
{
   void *task;
   char url[PATH_MAX_LENGTH];
   char *headers;
   retroarch_sync_cb_state_t *state;

   if (!retroarch_sync_build_url(url, sizeof(url), "file", path))
      return false;

   headers = retroarch_sync_headers(false);
   if (!headers)
      return false;

   state = (retroarch_sync_cb_state_t*)calloc(1, sizeof(*state));
   if (!state)
   {
      free(headers);
      return false;
   }

   state->cb        = cb;
   state->user_data = user_data;
   strlcpy(state->path, path, sizeof(state->path));

   RARCH_LOG(RARCH_SYNC_PFX "DELETE %s\n", url);
   task = task_push_webdav_delete(url, true, headers,
         retroarch_sync_delete_cb, state);
   free(headers);

   if (!task)
   {
      free(state);
      return false;
   }
   return true;
}

static bool retroarch_sync_begin(cloud_sync_complete_handler_t cb, void *user_data)
{
   char *base = retroarch_sync_base_url();
   char *headers = retroarch_sync_headers(false);
   bool success = !string_is_empty(base) && !string_is_empty(headers);

   if (!success)
      RARCH_WARN(RARCH_SYNC_PFX "Missing server URL or login cookie.\n");

   free(base);
   free(headers);
   cb(user_data, NULL, success, NULL);
   return true;
}

static bool retroarch_sync_end(cloud_sync_complete_handler_t cb, void *user_data)
{
   cb(user_data, NULL, true, NULL);
   return true;
}

static char *retroarch_sync_md5_rfile(RFILE *file)
{
   int rv;
   MD5_CTX md5;
   unsigned char buf[4096];
   unsigned char digest[16];
   libretro_vfs_implementation_file *hfile = filestream_get_vfs_handle(file);
   char *hash = (char*)malloc(33);

   if (!hash)
      return NULL;

   MD5_Init(&md5);

   if (hfile && hfile->mapped)
      MD5_Update(&md5, hfile->mapped, hfile->size);
   else
   {
      do
      {
         rv = (int)filestream_read(file, buf, sizeof(buf));
         if (rv > 0)
            MD5_Update(&md5, buf, rv);
      } while (rv > 0);
   }
   MD5_Final(digest, &md5);

   snprintf(hash, 33,
         "%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x",
         digest[0], digest[1], digest[2], digest[3],
         digest[4], digest[5], digest[6], digest[7],
         digest[8], digest[9], digest[10], digest[11],
         digest[12], digest[13], digest[14], digest[15]);

   return hash;
}

static bool retroarch_sync_upload_should_ignore_file(const char *filename)
{
   return string_ends_with(filename, "/.DS_Store");
}

static void retroarch_sync_upload_append_dir(file_list_t *manifest,
      const char *dir_fullpath, const char *dir_name)
{
   size_t i;
   struct string_list *dir_list;
   char dir_fullpath_slash[PATH_MAX_LENGTH];

   if (string_is_empty(dir_fullpath) || !path_is_directory(dir_fullpath))
      return;

   strlcpy(dir_fullpath_slash, dir_fullpath, sizeof(dir_fullpath_slash));
   fill_pathname_slash(dir_fullpath_slash, sizeof(dir_fullpath_slash));

   dir_list = dir_list_new(dir_fullpath_slash, NULL, false, true, true, true);
   if (!dir_list)
      return;

   file_list_reserve(manifest, manifest->size + dir_list->size);
   for (i = 0; i < dir_list->size; i++)
   {
      size_t idx            = manifest->size;
      const char *full_path = dir_list->elems[i].data;
      char relative_path[PATH_MAX_LENGTH];
      char alt[PATH_MAX_LENGTH];

      path_relative_to(relative_path, full_path, dir_fullpath_slash,
            sizeof(relative_path));
      fill_pathname_join_special(alt, dir_name, relative_path, sizeof(alt));
      pathname_make_slashes_portable(alt);

      if (retroarch_sync_upload_should_ignore_file(alt))
         continue;

      file_list_append(manifest, full_path, NULL, 0, 0, 0);
      file_list_set_alt_at_offset(manifest, idx, alt);
   }

   string_list_free(dir_list);
}

static bool retroarch_sync_upload_write_manifest(
      file_list_t *manifest, const char *path, RFILE **file)
{
   rjsonwriter_t *writer;
   size_t i;

   filestream_delete(path);
   *file = filestream_open(path,
         RETRO_VFS_FILE_ACCESS_READ_WRITE,
         RETRO_VFS_FILE_ACCESS_HINT_NONE);
   if (!*file)
      return false;

   writer = rjsonwriter_open_rfile(*file);
   if (!writer)
   {
      filestream_close(*file);
      *file = NULL;
      return false;
   }

   file_list_sort_on_alt(manifest);
   rjsonwriter_raw(writer, "[\n", 2);

   for (i = 0; i < manifest->size; i++)
   {
      struct item_file *item = &manifest->list[i];

      if (i)
         rjsonwriter_raw(writer, ",\n", 2);

      rjsonwriter_add_spaces(writer, 2);
      rjsonwriter_raw(writer, "{\n", 2);
      rjsonwriter_add_spaces(writer, 4);
      rjsonwriter_add_string(writer, "path");
      rjsonwriter_raw(writer, ": ", 2);
      rjsonwriter_add_string(writer, RS_FILE_KEY(item));
      rjsonwriter_raw(writer, ",\n", 2);
      rjsonwriter_add_spaces(writer, 4);
      rjsonwriter_add_string(writer, "hash");
      rjsonwriter_raw(writer, ": ", 2);
      if (RS_FILE_HASH(item))
         rjsonwriter_add_string(writer, RS_FILE_HASH(item));
      else
         rjsonwriter_raw(writer, "null", 4);
      rjsonwriter_raw(writer, "\n", 1);
      rjsonwriter_add_spaces(writer, 2);
      rjsonwriter_raw(writer, "}", 1);
   }

   rjsonwriter_raw(writer, "\n]\n", 3);
   rjsonwriter_free(writer);
   filestream_seek(*file, 0, SEEK_SET);
   return true;
}

static void retroarch_sync_upload_file_cb(void *user_data,
      const char *path, bool success, RFILE *file)
{
   retroarch_sync_upload_state_t *state =
      (retroarch_sync_upload_state_t*)user_data;

   if (file)
      filestream_close(file);

   if (!state)
      return;

   if (success)
      state->uploaded++;
   else
   {
      state->failed++;
      RARCH_WARN(RARCH_SYNC_PFX "Upload of \"%s\" failed.\n", path);
   }

   if (state->pending)
      state->pending--;
}

static void retroarch_sync_upload_manifest_cb(void *user_data,
      const char *path, bool success, RFILE *file)
{
   retroarch_sync_upload_state_t *state =
      (retroarch_sync_upload_state_t*)user_data;

   if (file)
      filestream_close(file);

   if (!state)
      return;

   state->manifest_uploaded = success;
   if (!success)
   {
      state->failed++;
      RARCH_WARN(RARCH_SYNC_PFX "Upload of manifest failed.\n");
   }

   if (state->pending)
      state->pending--;
}

static void retroarch_sync_upload_task_handler(retro_task_t *task)
{
   retroarch_sync_upload_state_t *state =
      (retroarch_sync_upload_state_t*)task->state;

   if (!state || state->pending)
      return;

   if (state->failed)
   {
      task_set_title(task, strdup("Cloud Upload failed"));
      task_set_progress(task, 100);
      task_set_flags(task, RETRO_TASK_FLG_FINISHED, true);
      return;
   }

   if (!state->manifest_started)
   {
      RFILE *manifest_file = NULL;
      state->manifest_started = true;

      if (!state->manifest_changed)
      {
         char msg[128];
         snprintf(msg, sizeof(msg), "Cloud Upload complete: %u skipped",
               state->skipped);
         task_set_title(task, strdup(msg));
         task_set_progress(task, 100);
         task_set_flags(task, RETRO_TASK_FLG_FINISHED, true);
         return;
      }

      if (!retroarch_sync_upload_write_manifest(state->updated_manifest,
               state->manifest_path, &manifest_file))
      {
         state->failed++;
         return;
      }

      state->pending++;
      if (!retroarch_sync_update(RARCH_SYNC_MANIFEST, manifest_file,
               retroarch_sync_upload_manifest_cb, state))
      {
         filestream_close(manifest_file);
         state->pending--;
         state->failed++;
      }
      return;
   }

   task_set_title(task, strdup("Cloud Upload complete"));
   task_set_progress(task, 100);
   task_set_flags(task, RETRO_TASK_FLG_FINISHED, true);
}

static void retroarch_sync_upload_task_cb(retro_task_t *task,
      void *task_data, void *user_data, const char *error)
{
   retroarch_sync_upload_state_t *state =
      (retroarch_sync_upload_state_t*)task_data;

   (void)task;
   (void)user_data;
   (void)error;

   if (!state)
      return;

   if (!string_is_empty(state->manifest_path))
      filestream_delete(state->manifest_path);
   /* Do not pass this transient upload list through file_list_free().
    * On Android/scudo, freeing this list after async upload callbacks can trip
    * invalid chunk state checks. The list is tiny and upload is manual, so keep
    * this path crash-free for now and replace it with a dedicated vector later. */
   free(state);
}

static void retroarch_sync_upload_server_manifest_cb(void *user_data,
      const char *path, bool success, RFILE *file)
{
   size_t i;
   retro_task_t *task = NULL;
   retroarch_sync_upload_state_t *state =
      (retroarch_sync_upload_state_t*)user_data;

   (void)path;

   if (!state)
      return;

   if (!success)
   {
      RARCH_WARN(RARCH_SYNC_PFX "Could not fetch server manifest for upload.\n");
      if (file)
         filestream_close(file);
      free(state);
      return;
   }

   if (file)
   {
      int len = 0;
      char *data = retroarch_sync_read_rfile(file, &len);
      filestream_close(file);
      if (data)
      {
         state->server_manifest = retroarch_sync_manifest_parse(data, len);
         free(data);
      }
   }

   if (!state->server_manifest)
      state->server_manifest = (file_list_t*)calloc(1, sizeof(*state->server_manifest));

   state->updated_manifest = retroarch_sync_manifest_clone(state->server_manifest);
   if (!state->server_manifest || !state->updated_manifest)
   {
      state->failed++;
      free(state);
      return;
   }

   if (!(task = task_init()))
   {
      free(state);
      return;
   }

   for (i = 0; i < state->manifest->size; i++)
   {
      struct item_file *item = &state->manifest->list[i];
      struct item_file *server_item =
         retroarch_sync_manifest_find_exact(state->server_manifest,
               RS_FILE_KEY(item));
      const char *server_hash = server_item ? RS_FILE_HASH(server_item) : NULL;
      RFILE *file_to_upload = NULL;

      if (string_is_empty(RS_FILE_HASH(item)))
      {
         RARCH_WARN(RARCH_SYNC_PFX "Skipping \"%s\" because local hash is empty.\n",
               RS_FILE_KEY(item));
         state->skipped++;
         continue;
      }

      if (server_item && server_hash && string_is_equal(server_hash, RS_FILE_HASH(item)))
      {
         state->skipped++;
         continue;
      }

      file_to_upload = filestream_open(item->path,
            RETRO_VFS_FILE_ACCESS_READ,
            RETRO_VFS_FILE_ACCESS_HINT_FREQUENT_ACCESS);
      if (!file_to_upload)
      {
         state->failed++;
         continue;
      }

      retroarch_sync_manifest_set(state->updated_manifest,
            RS_FILE_KEY(item), RS_FILE_HASH(item));
      retroarch_sync_log_state_rfile("upload local",
            RS_FILE_KEY(item), file_to_upload, RS_FILE_HASH(item));
      if (retroarch_sync_is_state_path(RS_FILE_KEY(item)))
         retroarch_sync_log_options_snapshot("before state upload");
      state->manifest_changed = true;
      state->pending++;
      if (!retroarch_sync_update(RS_FILE_KEY(item), file_to_upload,
               retroarch_sync_upload_file_cb, state))
      {
         filestream_close(file_to_upload);
         state->pending--;
         state->failed++;
      }
   }

   task->state    = state;
   task->title    = strdup("Cloud Upload in progress");
   task->handler  = retroarch_sync_upload_task_handler;
   task->callback = retroarch_sync_upload_task_cb;
   task_set_progress(task, 0);
   task_queue_push(task);
}

void retroarch_sync_upload_local_saves(void)
{
   size_t i;
   char manifest_path[PATH_MAX_LENGTH];
   const char *path_dir_core_assets = config_get_ptr()->paths.directory_core_assets;
   retroarch_sync_upload_state_t *state = NULL;
   char *base = retroarch_sync_base_url();
   char *headers = retroarch_sync_headers(false);

   if (string_is_empty(base) || string_is_empty(headers))
   {
      RARCH_WARN(RARCH_SYNC_PFX "Missing server URL or login cookie.\n");
      free(base);
      free(headers);
      return;
   }

   free(base);
   free(headers);

   state = (retroarch_sync_upload_state_t*)calloc(1, sizeof(*state));
   if (!state)
      return;

   state->manifest = (file_list_t*)calloc(1, sizeof(*state->manifest));
   if (!state->manifest)
      goto error;

   retroarch_sync_upload_append_dir(state->manifest,
         dir_get_ptr(RARCH_DIR_SAVEFILE), "saves");
   retroarch_sync_upload_append_dir(state->manifest,
         dir_get_ptr(RARCH_DIR_SAVESTATE), "states");

   if (!state->manifest->size)
   {
      RARCH_LOG(RARCH_SYNC_PFX "No local saves or states to upload.\n");
      retroarch_sync_show_manifest_message("Cloud upload", "no local saves", "0");
      goto error;
   }

   fill_pathname_join_special(manifest_path, path_dir_core_assets,
         RARCH_SYNC_UPLOAD_MANIFEST, sizeof(manifest_path));
   strlcpy(state->manifest_path, manifest_path, sizeof(state->manifest_path));

   for (i = 0; i < state->manifest->size; i++)
   {
      struct item_file *item = &state->manifest->list[i];
      RFILE *file = filestream_open(item->path,
            RETRO_VFS_FILE_ACCESS_READ,
            RETRO_VFS_FILE_ACCESS_HINT_FREQUENT_ACCESS);
      char *hash;
      int64_t size;

      if (!file)
      {
         state->failed++;
         continue;
      }

      size = filestream_get_size(file);
      if (size == 0)
      {
         RARCH_WARN(RARCH_SYNC_PFX "Skipping zero-byte local file \"%s\".\n",
               RS_FILE_KEY(item));
         filestream_close(file);
         state->skipped++;
         continue;
      }

      hash = retroarch_sync_md5_rfile(file);
      if (!hash)
      {
         filestream_close(file);
         state->failed++;
         continue;
      }

      item->userdata = hash;
      retroarch_sync_log_state_rfile("local scan",
            RS_FILE_KEY(item), file, hash);
      filestream_close(file);
   }

   RARCH_LOG(RARCH_SYNC_PFX "Fetching server manifest before incremental upload.\n");
   if (!retroarch_sync_read(RARCH_SYNC_MANIFEST, state->manifest_path,
            retroarch_sync_upload_server_manifest_cb, state))
      goto error;

   return;

error:
   if (state)
   {
      free(state);
   }
}

cloud_sync_driver_t cloud_sync_retroarch_sync = {
   retroarch_sync_begin,
   retroarch_sync_end,
   retroarch_sync_read,
   retroarch_sync_update,
   retroarch_sync_delete,
   "retroarch_sync"
};
