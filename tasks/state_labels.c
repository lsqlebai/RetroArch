#include <formats/rjson.h>
#include <formats/rjson_helpers.h>
#include <file/file_path.h>
#include <streams/file_stream.h>
#include <string/stdstring.h>
#include <compat/strl.h>
#include <stdlib.h>

#if defined(HAVE_EMSCRIPTEN) || defined(__EMSCRIPTEN__)
#include <emscripten/emscripten.h>
#endif

#ifdef HAVE_CONFIG_H
#include "../config.h"
#endif

#include "../retroarch.h"
#include "../file_path_special.h"
#include "../paths.h"
#include "../runloop.h"
#include "../verbosity.h"
#include "state_labels.h"

#define STATE_LABELS_FILE "state-labels.json"

static void state_labels_notify_sync_dirty(const char *path)
{
#if defined(HAVE_EMSCRIPTEN) || defined(__EMSCRIPTEN__)
   if (string_is_empty(path))
      return;

   MAIN_THREAD_EM_ASM({
      var path = UTF8ToString($0);
      if (typeof window !== "undefined" &&
            window.RetroArchSaveSync &&
            typeof window.RetroArchSaveSync.markDirty === "function")
         window.RetroArchSaveSync.markDirty(path);
   }, path);
#else
   (void)path;
#endif
}

typedef struct state_label_entry
{
   char *key;
   char *label;
} state_label_entry_t;

typedef struct state_label_map
{
   state_label_entry_t *entries;
   size_t size;
} state_label_map_t;

static void state_labels_map_free(state_label_map_t *map)
{
   size_t i;

   if (!map)
      return;

   for (i = 0; i < map->size; i++)
   {
      free(map->entries[i].key);
      free(map->entries[i].label);
   }

   free(map->entries);
   map->entries = NULL;
   map->size    = 0;
}

static bool state_labels_map_set(state_label_map_t *map,
      const char *key, const char *label)
{
   size_t i;

   if (!map || string_is_empty(key))
      return false;

   for (i = 0; i < map->size; i++)
   {
      if (string_is_equal(map->entries[i].key, key))
      {
         free(map->entries[i].label);
         map->entries[i].label = string_is_empty(label) ? NULL : strdup(label);
         return string_is_empty(label) || map->entries[i].label;
      }
   }

   if (string_is_empty(label))
      return true;

   {
      state_label_entry_t *entries = (state_label_entry_t*)realloc(map->entries,
            (map->size + 1) * sizeof(*entries));
      char *new_key                  = NULL;
      char *new_label                = NULL;

      if (!entries)
         return false;

      new_key   = strdup(key);
      new_label = strdup(label);

      if (!new_key || !new_label)
      {
         free(new_key);
         free(new_label);
         return false;
      }

      map->entries                  = entries;
      map->entries[map->size].key   = new_key;
      map->entries[map->size].label = new_label;

      map->size++;
   }

   return true;
}

static const char *state_labels_map_get(state_label_map_t *map,
      const char *key)
{
   size_t i;

   if (!map || string_is_empty(key))
      return NULL;

   for (i = 0; i < map->size; i++)
      if (string_is_equal(map->entries[i].key, key))
         return map->entries[i].label;

   return NULL;
}

static bool state_labels_get_file_path(char *path, size_t len)
{
   const char *state_dir = dir_get_ptr(RARCH_DIR_SAVESTATE);

   if (string_is_empty(state_dir))
      return false;

   fill_pathname_join_special(path, state_dir, STATE_LABELS_FILE, len);
   return !string_is_empty(path);
}

static bool state_labels_get_key_for_slot(int slot, char *key, size_t key_len)
{
   char state_path[PATH_MAX_LENGTH];
   char state_dir[DIR_MAX_LENGTH];
   const char *base_dir = dir_get_ptr(RARCH_DIR_SAVESTATE);

   if (slot < 0 || !key || !key_len || string_is_empty(base_dir))
      return false;

   if (!runloop_get_savestate_path(state_path, sizeof(state_path), slot))
      return false;

   if (!path_is_valid(state_path))
      return false;

   strlcpy(state_dir, base_dir, sizeof(state_dir));
   fill_pathname_slash(state_dir, sizeof(state_dir));
   path_relative_to(key, state_path, state_dir, key_len);
   pathname_make_slashes_portable(key);

   return !string_is_empty(key) && !string_starts_with(key, "..");
}

static bool state_labels_read_map(state_label_map_t *map)
{
   char path[PATH_MAX_LENGTH];
   RFILE *file = NULL;
   rjson_t *json = NULL;
   enum rjson_type type;
   char current_key[PATH_MAX_LENGTH];

   current_key[0] = '\0';

   if (!map || !state_labels_get_file_path(path, sizeof(path)))
      return false;

   if (!path_is_valid(path))
      return true;

   file = filestream_open(path, RETRO_VFS_FILE_ACCESS_READ,
         RETRO_VFS_FILE_ACCESS_HINT_NONE);
   if (!file)
      return false;

   json = rjson_open_rfile(file);
   if (!json)
   {
      filestream_close(file);
      return false;
   }

   while ((type = rjson_next(json)) != RJSON_DONE && type != RJSON_ERROR)
   {
      unsigned depth = rjson_get_context_depth(json);

      if (depth != 1 || rjson_get_context_type(json) != RJSON_OBJECT)
         continue;

      if (type == RJSON_STRING && (rjson_get_context_count(json) & 1))
      {
         strlcpy(current_key, rjson_get_string(json, NULL),
               sizeof(current_key));
         continue;
      }

      if (type == RJSON_STRING && !string_is_empty(current_key))
      {
         state_labels_map_set(map, current_key, rjson_get_string(json, NULL));
         current_key[0] = '\0';
      }
   }

   if (type == RJSON_ERROR)
      RARCH_WARN("[StateLabels] Failed to parse %s: %s\n",
            path, rjson_get_error(json));

   rjson_free(json);
   filestream_close(file);

   return type != RJSON_ERROR;
}

static bool state_labels_write_map(state_label_map_t *map)
{
   size_t i;
   bool wrote_any = false;
   char path[PATH_MAX_LENGTH];
   char dir[DIR_MAX_LENGTH];
   RFILE *file = NULL;
   rjsonwriter_t *writer = NULL;

   if (!map || !state_labels_get_file_path(path, sizeof(path)))
      return false;

   fill_pathname_basedir(dir, path, sizeof(dir));
   path_mkdir(dir);

   file = filestream_open(path, RETRO_VFS_FILE_ACCESS_WRITE,
         RETRO_VFS_FILE_ACCESS_HINT_NONE);
   if (!file)
      return false;

   writer = rjsonwriter_open_rfile(file);
   if (!writer)
   {
      filestream_close(file);
      return false;
   }

   rjsonwriter_raw(writer, "{\n", 2);

   for (i = 0; i < map->size; i++)
   {
      if (string_is_empty(map->entries[i].key) ||
            string_is_empty(map->entries[i].label))
         continue;

      if (wrote_any)
         rjsonwriter_raw(writer, ",\n", 2);

      rjsonwriter_add_spaces(writer, 2);
      rjsonwriter_add_string(writer, map->entries[i].key);
      rjsonwriter_raw(writer, ": ", 2);
      rjsonwriter_add_string(writer, map->entries[i].label);
      wrote_any = true;
   }

   rjsonwriter_raw(writer, wrote_any ? "\n}\n" : "}\n", wrote_any ? 3 : 2);
   rjsonwriter_free(writer);
   filestream_close(file);
   state_labels_notify_sync_dirty(path);

   return true;
}

bool state_labels_get_label_for_slot(int slot, char *label, size_t len)
{
   bool ret = false;
   char key[PATH_MAX_LENGTH];
   state_label_map_t map = {0};

   if (!label || !len)
      return false;

   label[0] = '\0';

   if (!state_labels_get_key_for_slot(slot, key, sizeof(key)))
      return false;

   if (state_labels_read_map(&map))
   {
      const char *value = state_labels_map_get(&map, key);
      if (!string_is_empty(value))
      {
         strlcpy(label, value, len);
         ret = true;
      }
   }

   state_labels_map_free(&map);
   return ret;
}

bool state_labels_get_display_for_slot(int slot, char *label, size_t len)
{
   char name[NAME_MAX_LENGTH];

   if (!label || !len)
      return false;

   if (slot < 0)
      return false;

   if (!state_labels_get_label_for_slot(slot, name, sizeof(name)))
      return false;

   snprintf(label, len, "%d - %s", slot, name);
   return true;
}

bool state_labels_set_label_for_slot(int slot, const char *label)
{
   bool ret = false;
   char key[PATH_MAX_LENGTH];
   state_label_map_t map = {0};

   if (!state_labels_get_key_for_slot(slot, key, sizeof(key)))
      return false;

   state_labels_read_map(&map);
   if (state_labels_map_set(&map, key, label))
      ret = state_labels_write_map(&map);

   state_labels_map_free(&map);
   return ret;
}
