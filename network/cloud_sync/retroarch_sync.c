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
#include <net/net_http.h>
#include <streams/file_stream.h>
#include <string/stdstring.h>
#include <compat/strl.h>

#include "../../configuration.h"
#include "../../frontend/drivers/platform_unix.h"
#include "../../paths.h"
#include "../../tasks/tasks_internal.h"
#include "../../verbosity.h"

#define RARCH_SYNC_PFX "[retroarch_sync] "
#define RARCH_SYNC_MANIFEST "manifest.server"

typedef struct
{
   cloud_sync_complete_handler_t cb;
   void *user_data;
   RFILE *rfile;
   char path[PATH_MAX_LENGTH];
   char file[PATH_MAX_LENGTH];
   bool is_manifest;
} retroarch_sync_cb_state_t;

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

static char *retroarch_sync_parse_file_data(const char *json_data, size_t len)
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
      type = rjson_next(json);

      if (     key
            && key_len == STRLEN_CONST("data")
            && memcmp(key, "data", key_len) == 0
            && type == RJSON_STRING)
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

static void retroarch_sync_read_cb(retro_task_t *task,
      void *task_data, void *user_data, const char *err)
{
   retroarch_sync_cb_state_t *state = (retroarch_sync_cb_state_t*)user_data;
   http_transfer_data_t *data       = (http_transfer_data_t*)task_data;
   RFILE *file                      = NULL;
   bool success                     = data
      && ((data->status >= 200 && data->status < 300) || data->status == 404);

   (void)task;
   (void)err;

   if (!state)
      return;

   if (success && data && data->status != 404 && data->data)
   {
      if (state->is_manifest)
      {
         file = filestream_open(state->file,
               RETRO_VFS_FILE_ACCESS_READ_WRITE,
               RETRO_VFS_FILE_ACCESS_HINT_NONE);
         if (file)
         {
            filestream_write(file, data->data, data->len);
            filestream_seek(file, 0, SEEK_SET);
         }
      }
      else
      {
         char *encoded = retroarch_sync_parse_file_data(data->data, data->len);
         if (encoded)
         {
            int decoded_len = 0;
            unsigned char *decoded = unbase64(encoded, (int)strlen(encoded), &decoded_len);
            if (decoded)
            {
               file = filestream_open(state->file,
                     RETRO_VFS_FILE_ACCESS_READ_WRITE,
                     RETRO_VFS_FILE_ACCESS_HINT_NONE);
               if (file)
               {
                  filestream_write(file, decoded, decoded_len);
                  filestream_seek(file, 0, SEEK_SET);
               }
               free(decoded);
            }
            free(encoded);
         }
      }
   }
   else if (!success && data)
      RARCH_WARN(RARCH_SYNC_PFX "GET %s failed with HTTP %d.\n",
            state->path, data->status);

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

cloud_sync_driver_t cloud_sync_retroarch_sync = {
   retroarch_sync_begin,
   retroarch_sync_end,
   retroarch_sync_read,
   retroarch_sync_update,
   retroarch_sync_delete,
   "retroarch_sync"
};
