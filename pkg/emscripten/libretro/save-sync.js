/**
 * RetroArch cloud_sync-compatible synchronization for the single-threaded web
 * player.
 *
 * This mirrors RetroArch's C-layer task_cloudsync.c model:
 * - server manifest is an array of {path, hash}
 * - local manifest is the last successfully synced {path, hash} array
 * - current manifest is built by scanning saves/states
 * - hash === null is a tombstone
 *
 * Do not inspect BrowserFS' IndexedDB key/value store directly: those keys are
 * BrowserFS inode/data blocks, not RetroArch file paths.
 */
(function(global) {
   "use strict";

   var DEFAULT_BASE_PATH = "/home/web_user/retroarch/userdata";
   var DEFAULT_DIRS = ["saves", "states"];
   var DEFAULT_API_BASE = "/api/sync/v1";
   var DEFAULT_GAME_ID = "default";
   var LOCAL_MANIFEST_KEY = "retroarch-cloud-sync-local-manifest-v1";
   var CONFLICTS_KEY = "retroarch-cloud-sync-conflicts-v1";
   var DEVICE_ID_KEY = "retroarch-cloud-sync-device-id";
   var SYNC_DEBOUNCE_MS = 8000;
   var INITIAL_SYNC_TIMEOUT_MS = 5000;
   var syncNoticeTimer = null;
   var syncDebugLogs = /\bsyncdebug=1\b/.test(global.location && global.location.search || "");

   function makeDeviceId() {
      if (global.crypto && global.crypto.randomUUID)
         return global.crypto.randomUUID();
      return "device-" + Math.random().toString(16).slice(2) + Date.now();
   }

   function safeJsonParse(value, fallback) {
      if (!value)
         return fallback;
      try {
         return JSON.parse(value);
      } catch (e) {
         return fallback;
      }
   }

   function pathJoin(a, b) {
      return a.replace(/\/+$/, "") + "/" + b.replace(/^\/+/, "");
   }

   function normalizeRelPath(path, basePath) {
      if (!path)
         return null;
      if (path.indexOf(basePath + "/") === 0)
         path = path.slice(basePath.length + 1);
      path = path.replace(/^\/+/, "");
      if (!path || path.indexOf("..") >= 0)
         return null;
      return path;
   }

   function isSyncedRelPath(path, dirs) {
      for (var i = 0; i < dirs.length; i++)
      {
         if (path === dirs[i] || path.indexOf(dirs[i] + "/") === 0)
            return true;
      }
      return false;
   }

   function stateFileBaseName(relPath) {
      var match = /^states\/[^/]+\/(.+\.state)(?:\d+)?$/.exec(relPath || "");
      return match ? match[1].slice(0, -".state".length) : null;
   }

   function isStateLabelsPath(relPath) {
      return relPath === "states/state-labels.json";
   }

   function isStateDataPath(relPath) {
      return !!stateFileBaseName(relPath);
   }

   function isMaybeStatePath(path) {
      return /\.state(?:\d+)?(?:$|[?#])/.test(path || "");
   }

   function isSaveDataPath(relPath) {
      return /^saves\//.test(relPath || "");
   }

   function isProtectedRemotePath(relPath) {
      return isStateLabelsPath(relPath) || isStateDataPath(relPath) ||
         isSaveDataPath(relPath);
   }

   function isGameStatePath(relPath, stateBaseName) {
      var baseName = stateFileBaseName(relPath);
      return !baseName || !stateBaseName || baseName === stateBaseName;
   }

   function textFromBytes(bytes) {
      if (typeof TextDecoder !== "undefined")
         return new TextDecoder("utf-8").decode(bytes);

      var text = "";
      for (var i = 0; i < bytes.length; i++)
         text += String.fromCharCode(bytes[i]);
      return decodeURIComponent(escape(text));
   }

   function bytesFromText(text) {
      if (typeof TextEncoder !== "undefined")
         return new TextEncoder().encode(text);

      text = unescape(encodeURIComponent(text));
      var bytes = new Uint8Array(text.length);
      for (var i = 0; i < text.length; i++)
         bytes[i] = text.charCodeAt(i);
      return bytes;
   }

   function sanitizeStateLabelsBytes(bytes, stateBaseName) {
      var parsed;
      var cleaned = {};
      var key;
      var kept = 0;

      try {
         parsed = JSON.parse(textFromBytes(bytes));
      } catch (e) {
         return null;
      }

      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      {
         for (key in parsed)
         {
            if (typeof parsed[key] !== "string")
               continue;
            if (!stateBaseName || isGameStatePath("states/" + key, stateBaseName))
            {
               cleaned[key] = parsed[key];
               kept++;
            }
         }
      }

      if (stateBaseName && !kept)
         return null;

      return bytesFromText(JSON.stringify(cleaned, null, 2) + "\n");
   }

   function logStateLabels(scope, bytes, extra) {
      if (!syncDebugLogs)
         return;
      var text = "";
      try {
         text = textFromBytes(bytes || new Uint8Array());
      } catch (e) {
         text = "<decode failed: " + (e && e.message ? e.message : String(e)) + ">";
      }
      console.log("[SaveSync] state-labels.json " + scope, Object.assign({
         length: bytes ? bytes.length : 0,
         content: text
      }, extra || {}));
   }

   function bytesHeadHex(bytes, maxLen) {
      var out = [];
      var len = Math.min(bytes ? bytes.length : 0, maxLen || 16);
      for (var i = 0; i < len; i++)
      {
         var hex = bytes[i].toString(16);
         out.push(hex.length === 1 ? "0" + hex : hex);
      }
      return out.join(" ");
   }

   function coerceBytes(data) {
      if (!data)
         return null;
      if (data instanceof Uint8Array)
         return data;
      if (data.buffer instanceof ArrayBuffer)
         return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
      if (data instanceof ArrayBuffer)
         return new Uint8Array(data);
      if (typeof data === "string")
         return bytesFromText(data);
      return null;
   }

   function bytesMagic(bytes, maxLen) {
      var out = "";
      var len = Math.min(bytes ? bytes.length : 0, maxLen || 8);
      for (var i = 0; i < len; i++)
      {
         var c = bytes[i];
         out += c >= 32 && c <= 126 ? String.fromCharCode(c) : ".";
      }
      return out;
   }

   function detectStateFormat(bytes) {
      if (!bytes || !bytes.length)
         return "empty";
      if (bytes.length >= 5 &&
            bytes[0] === 0x23 && bytes[1] === 0x52 && bytes[2] === 0x5a &&
            bytes[3] === 0x49 && bytes[4] === 0x50)
         return "rzip";
      if (bytes.length >= 7 &&
            bytes[0] === 0x52 && bytes[1] === 0x41 && bytes[2] === 0x53 &&
            bytes[3] === 0x54 && bytes[4] === 0x41 && bytes[5] === 0x54 &&
            bytes[6] === 0x45)
         return "rastate";
      if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b)
         return "zip";
      return "unknown";
   }

   function logStateFile(scope, relPath, bytes, extra) {
      if (!isStateDataPath(relPath) && !isMaybeStatePath(relPath))
         return;
      bytes = coerceBytes(bytes);
      console.log("[SaveSync][state]", scope, Object.assign({
         path: relPath,
         size: bytes ? bytes.length : 0,
         md5: bytes ? md5(bytes) : null,
         head16: bytesHeadHex(bytes, 16),
         magic: bytesMagic(bytes, 8),
         format: detectStateFormat(bytes)
      }, extra || {}));
   }

   function manifestToMap(manifest) {
      var map = {};
      (manifest || []).forEach(function(item) {
         if (item && item.path)
            map[item.path] = item.hash == null ? null : item.hash;
      });
      return map;
   }

   function mapToManifest(map) {
      return Object.keys(map).sort().map(function(path) {
         return {path: path, hash: map[path] == null ? null : map[path]};
      });
   }

   function manifestMapsEqual(a, b) {
      var path;
      var aKeys = Object.keys(a || {});
      var bKeys = Object.keys(b || {});

      if (aKeys.length !== bKeys.length)
         return false;

      for (path in a)
      {
         if (!Object.prototype.hasOwnProperty.call(b, path))
            return false;
         if ((a[path] == null ? null : a[path]) !== (b[path] == null ? null : b[path]))
            return false;
      }
      return true;
   }

   function bytesToBase64(bytes) {
      var chunk = 0x8000;
      var parts = [];
      for (var i = 0; i < bytes.length; i += chunk)
         parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)));
      return btoa(parts.join(""));
   }

   function base64ToBytes(text) {
      var binary = atob(text || "");
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++)
         bytes[i] = binary.charCodeAt(i);
      return bytes;
   }

   function md5(bytes) {
      function add32(a, b) { return (a + b) & 0xffffffff; }
      function rol(num, cnt) { return (num << cnt) | (num >>> (32 - cnt)); }
      function cmn(q, a, b, x, s, t) { return add32(rol(add32(add32(a, q), add32(x, t)), s), b); }
      function ff(a, b, c, d, x, s, t) { return cmn((b & c) | ((~b) & d), a, b, x, s, t); }
      function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
      function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
      function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }
      function hex(x) {
         var out = "";
         for (var i = 0; i < 4; i++)
            out += ((x >> (i * 8 + 4)) & 0x0f).toString(16) + ((x >> (i * 8)) & 0x0f).toString(16);
         return out;
      }

      var len = bytes.length;
      var words = [];
      var i;
      for (i = 0; i < len; i++)
         words[i >> 2] = (words[i >> 2] || 0) | (bytes[i] << ((i % 4) * 8));
      words[len >> 2] = (words[len >> 2] || 0) | (0x80 << ((len % 4) * 8));
      words[(((len + 8) >> 6) << 4) + 14] = len * 8;

      var a = 1732584193;
      var b = -271733879;
      var c = -1732584194;
      var d = 271733878;

      for (i = 0; i < words.length; i += 16)
      {
         var olda = a, oldb = b, oldc = c, oldd = d;
         a = ff(a, b, c, d, words[i + 0] || 0, 7, -680876936);
         d = ff(d, a, b, c, words[i + 1] || 0, 12, -389564586);
         c = ff(c, d, a, b, words[i + 2] || 0, 17, 606105819);
         b = ff(b, c, d, a, words[i + 3] || 0, 22, -1044525330);
         a = ff(a, b, c, d, words[i + 4] || 0, 7, -176418897);
         d = ff(d, a, b, c, words[i + 5] || 0, 12, 1200080426);
         c = ff(c, d, a, b, words[i + 6] || 0, 17, -1473231341);
         b = ff(b, c, d, a, words[i + 7] || 0, 22, -45705983);
         a = ff(a, b, c, d, words[i + 8] || 0, 7, 1770035416);
         d = ff(d, a, b, c, words[i + 9] || 0, 12, -1958414417);
         c = ff(c, d, a, b, words[i + 10] || 0, 17, -42063);
         b = ff(b, c, d, a, words[i + 11] || 0, 22, -1990404162);
         a = ff(a, b, c, d, words[i + 12] || 0, 7, 1804603682);
         d = ff(d, a, b, c, words[i + 13] || 0, 12, -40341101);
         c = ff(c, d, a, b, words[i + 14] || 0, 17, -1502002290);
         b = ff(b, c, d, a, words[i + 15] || 0, 22, 1236535329);

         a = gg(a, b, c, d, words[i + 1] || 0, 5, -165796510);
         d = gg(d, a, b, c, words[i + 6] || 0, 9, -1069501632);
         c = gg(c, d, a, b, words[i + 11] || 0, 14, 643717713);
         b = gg(b, c, d, a, words[i + 0] || 0, 20, -373897302);
         a = gg(a, b, c, d, words[i + 5] || 0, 5, -701558691);
         d = gg(d, a, b, c, words[i + 10] || 0, 9, 38016083);
         c = gg(c, d, a, b, words[i + 15] || 0, 14, -660478335);
         b = gg(b, c, d, a, words[i + 4] || 0, 20, -405537848);
         a = gg(a, b, c, d, words[i + 9] || 0, 5, 568446438);
         d = gg(d, a, b, c, words[i + 14] || 0, 9, -1019803690);
         c = gg(c, d, a, b, words[i + 3] || 0, 14, -187363961);
         b = gg(b, c, d, a, words[i + 8] || 0, 20, 1163531501);
         a = gg(a, b, c, d, words[i + 13] || 0, 5, -1444681467);
         d = gg(d, a, b, c, words[i + 2] || 0, 9, -51403784);
         c = gg(c, d, a, b, words[i + 7] || 0, 14, 1735328473);
         b = gg(b, c, d, a, words[i + 12] || 0, 20, -1926607734);

         a = hh(a, b, c, d, words[i + 5] || 0, 4, -378558);
         d = hh(d, a, b, c, words[i + 8] || 0, 11, -2022574463);
         c = hh(c, d, a, b, words[i + 11] || 0, 16, 1839030562);
         b = hh(b, c, d, a, words[i + 14] || 0, 23, -35309556);
         a = hh(a, b, c, d, words[i + 1] || 0, 4, -1530992060);
         d = hh(d, a, b, c, words[i + 4] || 0, 11, 1272893353);
         c = hh(c, d, a, b, words[i + 7] || 0, 16, -155497632);
         b = hh(b, c, d, a, words[i + 10] || 0, 23, -1094730640);
         a = hh(a, b, c, d, words[i + 13] || 0, 4, 681279174);
         d = hh(d, a, b, c, words[i + 0] || 0, 11, -358537222);
         c = hh(c, d, a, b, words[i + 3] || 0, 16, -722521979);
         b = hh(b, c, d, a, words[i + 6] || 0, 23, 76029189);
         a = hh(a, b, c, d, words[i + 9] || 0, 4, -640364487);
         d = hh(d, a, b, c, words[i + 12] || 0, 11, -421815835);
         c = hh(c, d, a, b, words[i + 15] || 0, 16, 530742520);
         b = hh(b, c, d, a, words[i + 2] || 0, 23, -995338651);

         a = ii(a, b, c, d, words[i + 0] || 0, 6, -198630844);
         d = ii(d, a, b, c, words[i + 7] || 0, 10, 1126891415);
         c = ii(c, d, a, b, words[i + 14] || 0, 15, -1416354905);
         b = ii(b, c, d, a, words[i + 5] || 0, 21, -57434055);
         a = ii(a, b, c, d, words[i + 12] || 0, 6, 1700485571);
         d = ii(d, a, b, c, words[i + 3] || 0, 10, -1894986606);
         c = ii(c, d, a, b, words[i + 10] || 0, 15, -1051523);
         b = ii(b, c, d, a, words[i + 1] || 0, 21, -2054922799);
         a = ii(a, b, c, d, words[i + 8] || 0, 6, 1873313359);
         d = ii(d, a, b, c, words[i + 15] || 0, 10, -30611744);
         c = ii(c, d, a, b, words[i + 6] || 0, 15, -1560198380);
         b = ii(b, c, d, a, words[i + 13] || 0, 21, 1309151649);
         a = ii(a, b, c, d, words[i + 4] || 0, 6, -145523070);
         d = ii(d, a, b, c, words[i + 11] || 0, 10, -1120210379);
         c = ii(c, d, a, b, words[i + 2] || 0, 15, 718787259);
         b = ii(b, c, d, a, words[i + 9] || 0, 21, -343485551);

         a = add32(a, olda);
         b = add32(b, oldb);
         c = add32(c, oldc);
         d = add32(d, oldd);
      }
      return hex(a) + hex(b) + hex(c) + hex(d);
   }

   function requestJson(url, options) {
      options = options || {};
      options.headers = Object.assign({
         "Accept": "application/json",
         "Content-Type": "application/json"
      }, options.headers || {});
      options.credentials = options.credentials || "same-origin";
      return fetch(url, options).then(function(resp) {
         return resp.text().then(function(text) {
            var data = safeJsonParse(text, {});
            if (!resp.ok)
            {
               var err = new Error(data.error || ("HTTP " + resp.status));
               err.response = data;
               err.status = resp.status;
               throw err;
            }
            data.__headers = resp.headers;
            return data;
         });
      });
   }

   function shortVersion(version) {
      if (!version)
         return "unknown";
      return version.indexOf(":") >= 0 ? version.slice(0, 19) : version.slice(0, 12);
   }

   function manifestMetaFromResponse(data) {
      var files = Array.isArray(data) ? data : (data.files || []);
      var headers = data.__headers;
      return {
         version: headers ? headers.get("X-RetroArch-Cloud-Manifest-Version") : null,
         updatedAt: headers ? headers.get("X-RetroArch-Cloud-Manifest-Updated-At") : null,
         entries: headers && headers.get("X-RetroArch-Cloud-Manifest-Entries")
            ? Number(headers.get("X-RetroArch-Cloud-Manifest-Entries")) : files.length,
         files: files
      };
   }

   function stripResponseHeaders(data) {
      if (data && data.__headers)
         delete data.__headers;
      return data;
   }

   function isFinalStatus(status) {
      return status === "synced" ||
         status === "uploaded" ||
         status === "downloaded" ||
         status === "conflict" ||
         status === "offline" ||
         status.indexOf("failed") >= 0 ||
         status.indexOf("skipped") >= 0;
   }

   function SaveSync() {
      this.Module = null;
      this.basePath = DEFAULT_BASE_PATH;
      this.dirs = DEFAULT_DIRS.slice();
      this.apiBase = DEFAULT_API_BASE;
      this.userId = "1";
      this.gameId = DEFAULT_GAME_ID;
      this.deviceId = localStorage.getItem(DEVICE_ID_KEY) || makeDeviceId();
      this.localManifest = [];
      this.conflicts = [];
      this.initialized = false;
      this.syncing = false;
      this.pendingTimer = null;
      this.suppressDirty = false;
      this.hasDirtyHint = false;
      this.lastServerManifestMeta = null;
      this.lastRawServerManifest = [];
      this.stateBaseName = null;
      localStorage.setItem(DEVICE_ID_KEY, this.deviceId);
   }

   SaveSync.prototype.storageKey = function(key) {
      return key + ":" + this.userId + ":" + this.gameId;
   };

   SaveSync.prototype.loadScopedState = function() {
      this.localManifest = this.filterManifest(safeJsonParse(localStorage.getItem(
            this.storageKey(LOCAL_MANIFEST_KEY)), []));
      this.conflicts = safeJsonParse(localStorage.getItem(
            this.storageKey(CONFLICTS_KEY)), []);
   };

   SaveSync.prototype.saveLocalManifest = function(manifest) {
      this.localManifest = this.filterManifest(manifest || []);
      localStorage.setItem(this.storageKey(LOCAL_MANIFEST_KEY),
            JSON.stringify(this.localManifest));
   };

   SaveSync.prototype.saveConflicts = function() {
      localStorage.setItem(this.storageKey(CONFLICTS_KEY),
            JSON.stringify(this.conflicts || []));
   };

   SaveSync.prototype.setStatus = function(status, detail) {
      var text = detail ? status + ": " + detail : status;
      console.log("[SaveSync]", status, detail || "");
      var el = document.getElementById("syncStatus");
      if (el)
         el.textContent = text;
      var menuVersion = document.getElementById("menuSyncVersion");
      if (menuVersion)
      {
         menuVersion.textContent = "Cloud: " + (detail || status);
         menuVersion.title = text;
      }
      var notice = document.getElementById("syncNotice");
      if (notice && (detail || isFinalStatus(status)))
      {
         notice.textContent = text;
         notice.className = "sync-notice show" +
            (status.indexOf("failed") >= 0 || status === "offline" ? " error" : "");
         if (syncNoticeTimer)
            clearTimeout(syncNoticeTimer);
         syncNoticeTimer = setTimeout(function() {
            notice.className = "sync-notice";
         }, 7000);
      }
      var conflicts = document.getElementById("syncConflicts");
      if (conflicts)
         conflicts.textContent = String(this.getPendingConflicts().length);
   };

   SaveSync.prototype.init = async function(options) {
      options = options || {};
      this.Module = options.Module;
      this.basePath = options.basePath || this.basePath;
      this.dirs = options.dirs || this.dirs;
      this.apiBase = options.apiBase || this.apiBase;
      this.userId = options.userId || this.userId;
      this.gameId = options.gameId || this.gameId;
      this.stateBaseName = options.stateBaseName || null;
      this.loadScopedState();
      console.log("[SaveSync] API target", {
         origin: global.location && global.location.origin,
         apiBase: this.apiBase,
         manifestUrl: new URL(this.apiBase + "/manifest", global.location && global.location.href || "http://localhost/").href,
         fileUrl: new URL(this.apiBase + "/file", global.location && global.location.href || "http://localhost/").href,
         userId: this.userId,
         gameId: this.gameId
      });
      this.cleanupDisallowedLocalFiles();
      this.installFSHooks();
      this.initialized = true;
      this.setStatus("initializing");
      try {
         await this.syncWithTimeout(INITIAL_SYNC_TIMEOUT_MS);
      } catch (e) {
         this.setStatus("offline", e.message || String(e));
      }
   };

   SaveSync.prototype.syncWithTimeout = function(ms) {
      var self = this;
      return Promise.race([
         self.syncNow(),
         new Promise(function(_, reject) {
            setTimeout(function() {
               reject(new Error("initial sync timed out"));
            }, ms);
         })
      ]);
   };

   SaveSync.prototype.installFSHooks = function() {
      var self = this;
      var FS = this.Module && this.Module.FS;
      if (!FS || FS.__saveSyncHooksInstalled)
         return;
      FS.__saveSyncHooksInstalled = true;
      var MAX_STATE_READ_CAPTURE = 32 * 1024 * 1024;

      function readCaptureBytes(info) {
         var out = new Uint8Array(info.captured);
         var offset = 0;
         for (var i = 0; i < info.chunks.length; i++)
         {
            out.set(info.chunks[i], offset);
            offset += info.chunks[i].length;
         }
         return out;
      }

      function mark(path) {
         if (self.suppressDirty)
            return;
         var rel = normalizeRelPath(path, self.basePath);
         if (rel && isSyncedRelPath(rel, self.dirs))
         {
            self.hasDirtyHint = true;
            self.scheduleSync();
         }
      }

      function stateProbeInfo(path) {
         var rel = normalizeRelPath(path, self.basePath);
         if (rel && isStateDataPath(rel))
            return {relPath: rel, synced: true};
         if (isMaybeStatePath(path))
            return {relPath: rel || String(path || ""), synced: false};
         return null;
      }

      var origOpen = FS.open;
      FS.open = function(path, flags, mode) {
         var stream = origOpen.apply(this, arguments);
         var probe = stateProbeInfo(path);
         if (probe)
         {
            stream.__saveSyncStateRead = {
               relPath: probe.relPath,
               flags: flags,
               total: 0,
               captured: 0,
               chunks: []
            };
            console.log("[SaveSync][state-read] open", {
               path: probe.relPath,
               rawPath: path,
               syncedPath: probe.synced,
               flags: flags,
               fd: stream.fd
            });
            self.logCoreOptionsSnapshot("before state open");
         }
         return stream;
      };

      var origRead = FS.read;
      FS.read = function(stream, buffer, offset, length, position) {
         var ret = origRead.apply(this, arguments);
         var info = stream && stream.__saveSyncStateRead;
         if (info && ret > 0)
         {
            info.total += ret;
            if (info.captured < MAX_STATE_READ_CAPTURE)
            {
               var copyLen = Math.min(ret, MAX_STATE_READ_CAPTURE - info.captured);
               var source = coerceBytes(buffer);
               if (source)
               {
                  var chunk = new Uint8Array(copyLen);
                  chunk.set(source.subarray(offset, offset + copyLen));
                  info.chunks.push(chunk);
                  info.captured += copyLen;
               }
            }
         }
         return ret;
      };

      var origClose = FS.close;
      FS.close = function(stream) {
         var info = stream && stream.__saveSyncStateRead;
         var ret;
         try {
            ret = origClose.apply(this, arguments);
         } finally {
            if (info && info.total > 0)
            {
               logStateFile("FS read close", info.relPath, readCaptureBytes(info), {
                  fd: stream.fd,
                  flags: info.flags,
                  totalRead: info.total,
                  capturedBytes: info.captured,
                  truncated: info.total > info.captured
               });
               self.logCoreOptionsSnapshot("after state read");
            }
         }
         return ret;
      };

      var origWrite = FS.write;
      FS.write = function(stream, buffer, offset, length, position, canOwn) {
         var ret = origWrite.apply(this, arguments);
         if (stream && stream.path)
         {
            var rel = normalizeRelPath(stream.path, self.basePath);
            if ((rel && isStateDataPath(rel)) || isMaybeStatePath(stream.path))
               console.log("[SaveSync][state-write] FS.write", {
                  path: rel || stream.path,
                  fd: stream.fd,
                  length: length,
                  written: ret,
                  position: position
               });
            mark(stream.path);
         }
         return ret;
      };

      var origWriteFile = FS.writeFile;
      FS.writeFile = function(path, data, opts) {
         var ret = origWriteFile.apply(this, arguments);
         var rel = normalizeRelPath(path, self.basePath);
         if ((rel && isStateDataPath(rel)) || isMaybeStatePath(path))
         {
            logStateFile("FS.writeFile", rel || path, data);
            self.logCoreOptionsSnapshot("after FS.writeFile state");
         }
         mark(path);
         return ret;
      };

      var origReadFile = FS.readFile;
      FS.readFile = function(path, opts) {
         var data = origReadFile.apply(this, arguments);
         var rel = normalizeRelPath(path, self.basePath);
         if ((rel && isStateDataPath(rel)) || isMaybeStatePath(path))
         {
            logStateFile("FS.readFile", rel || path, data, {
               encoding: opts && opts.encoding || null
            });
            self.logCoreOptionsSnapshot("after FS.readFile state");
         }
         return data;
      };

      var origStat = FS.stat;
      FS.stat = function(path, dontFollow) {
         try {
            var st = origStat.apply(this, arguments);
            var probe = stateProbeInfo(path);
            if (probe)
               console.log("[SaveSync][state-probe] stat", {
                  path: probe.relPath,
                  rawPath: path,
                  syncedPath: probe.synced,
                  size: st && st.size,
                  mode: st && st.mode
               });
            return st;
         } catch (e) {
            var missingProbe = stateProbeInfo(path);
            if (missingProbe)
               console.warn("[SaveSync][state-probe] stat failed", {
                  path: missingProbe.relPath,
                  rawPath: path,
                  syncedPath: missingProbe.synced,
                  error: e && e.message ? e.message : String(e)
               });
            throw e;
         }
      };

      if (FS.analyzePath)
      {
         var origAnalyzePath = FS.analyzePath;
         FS.analyzePath = function(path, dontResolveLastLink) {
            var result = origAnalyzePath.apply(this, arguments);
            var probe = stateProbeInfo(path);
            if (probe)
               console.log("[SaveSync][state-probe] analyzePath", {
                  path: probe.relPath,
                  rawPath: path,
                  syncedPath: probe.synced,
                  exists: !!(result && result.exists),
                  error: result && result.error
               });
            return result;
         };
      }

      var origUnlink = FS.unlink;
      FS.unlink = function(path) {
         var ret = origUnlink.apply(this, arguments);
         mark(path);
         return ret;
      };
   };

   SaveSync.prototype.scheduleSync = function() {
      var self = this;
      if (this.pendingTimer)
         clearTimeout(this.pendingTimer);
      this.pendingTimer = setTimeout(function() {
         self.syncNow().catch(function(e) {
            self.setStatus("offline", e.message || String(e));
         });
      }, SYNC_DEBOUNCE_MS);
   };

   SaveSync.prototype.readdir = function(path) {
      try {
         return this.Module.FS.readdir(path).filter(function(name) {
            return name !== "." && name !== "..";
         });
      } catch (e) {
         return [];
      }
   };

   SaveSync.prototype.stat = function(path) {
      try {
         return this.Module.FS.stat(path);
      } catch (e) {
         return null;
      }
   };

   SaveSync.prototype.logCoreOptionsSnapshot = function(scope) {
      if (!this.Module || !this.Module.FS)
         return;

      [
         "retroarch.cfg",
         "retroarch-core-options.cfg",
         "config/DOSBox-pure/DOSBox-pure.opt"
      ].forEach(function(relPath) {
         var abs = pathJoin(this.basePath, relPath);
         var bytes;
         var text = "";
         try {
            bytes = this.Module.FS.readFile(abs, {encoding: "binary"});
            try {
               text = textFromBytes(bytes);
            } catch (e) {}
            console.log("[SaveSync][state-options]", scope, {
               path: relPath,
               size: bytes.length,
               md5: md5(bytes),
               savestateFileCompression: (text.match(/^savestate_file_compression\s*=\s*"([^"]*)"/m) || [])[1] || null,
               saveFileCompression: (text.match(/^save_file_compression\s*=\s*"([^"]*)"/m) || [])[1] || null,
               stateSlot: (text.match(/^state_slot\s*=\s*"?([^"\n]*)"?/m) || [])[1] || null,
               savestateDirectory: (text.match(/^savestate_directory\s*=\s*"([^"]*)"/m) || [])[1] || null,
               sortSavestatesEnable: (text.match(/^sort_savestates_enable\s*=\s*"([^"]*)"/m) || [])[1] || null,
               sortSavestatesByContentEnable: (text.match(/^sort_savestates_by_content_enable\s*=\s*"([^"]*)"/m) || [])[1] || null,
               savestateAutoIndex: (text.match(/^savestate_auto_index\s*=\s*"([^"]*)"/m) || [])[1] || null,
               dosboxPureSavestate: (text.match(/^dosbox_pure_savestate\s*=\s*"([^"]*)"/m) || [])[1] || null,
               mouseSpeed: (text.match(/^dosbox_pure_mouse_speed_factor\s*=\s*"([^"]*)"/m) || [])[1] || null,
               mouseInput: (text.match(/^dosbox_pure_mouse_input\s*=\s*"([^"]*)"/m) || [])[1] || null
            });
         } catch (e) {
            console.log("[SaveSync][state-options]", scope, {
               path: relPath,
               missing: true
            });
         }
      }, this);
   };

   SaveSync.prototype.listTree = function(relDir) {
      var self = this;
      var out = [];
      function walk(relPath) {
         var abs = pathJoin(self.basePath, relPath);
         var entries = self.readdir(abs);
         for (var i = 0; i < entries.length; i++)
         {
            var childRel = relPath + "/" + entries[i];
            var childAbs = pathJoin(self.basePath, childRel);
            var st = self.stat(childAbs);
            if (!st)
               continue;
            if (self.Module.FS.isDir(st.mode))
               walk(childRel);
            else
               out.push(childRel);
         }
      }
      walk(relDir);
      return out;
   };

   SaveSync.prototype.shouldSyncRelPath = function(relPath) {
      if (!isSyncedRelPath(relPath, this.dirs))
         return false;
      if (isStateLabelsPath(relPath))
         return true;
      if (isStateDataPath(relPath))
         return isGameStatePath(relPath, this.stateBaseName);
      return true;
   };

   SaveSync.prototype.filterManifest = function(manifest) {
      var self = this;
      return (manifest || []).filter(function(item) {
         return item && item.path &&
            self.shouldSyncRelPath(item.path) &&
            !(isProtectedRemotePath(item.path) && item.hash == null);
      });
   };

   SaveSync.prototype.cleanupDisallowedLocalFiles = function() {
      if (!this.Module || !this.Module.FS || !this.stateBaseName)
         return;

      var self = this;
      this.suppressDirty = true;
      try {
         this.listTree("states").forEach(function(relPath) {
            if (!self.shouldSyncRelPath(relPath))
            {
               self.deleteLocalFile(relPath);
               return;
            }
            if (isStateDataPath(relPath))
            {
               try {
                  var st = self.Module.FS.stat(pathJoin(self.basePath, relPath));
                  if (st && st.size === 0)
                  {
                     console.warn("[SaveSync] deleting zero-byte local state", relPath);
                     self.deleteLocalFile(relPath);
                  }
               } catch (e) {}
            }
         });
      } finally {
         this.suppressDirty = false;
      }
   };

   SaveSync.prototype.sanitizeStateLabelsFile = function() {
      if (!this.Module || !this.Module.FS)
         return;

      var relPath = "states/state-labels.json";
      var abs = pathJoin(this.basePath, relPath);
      var bytes;
      var cleaned;
      var beforeHash;
      var afterHash;

      try {
         bytes = this.Module.FS.readFile(abs, {encoding: "binary"});
      } catch (e) {
         return;
      }

      logStateLabels("sanitize local before", bytes, {
         path: relPath,
         stateBaseName: this.stateBaseName
      });
      cleaned = sanitizeStateLabelsBytes(bytes, this.stateBaseName);
      if (!cleaned)
      {
         if (syncDebugLogs)
            console.warn("[SaveSync] state-labels.json sanitize skipped", {
               path: relPath,
               stateBaseName: this.stateBaseName
            });
         return;
      }
      logStateLabels("sanitize local after", cleaned, {
         path: relPath,
         stateBaseName: this.stateBaseName
      });
      beforeHash = bytesToBase64(bytes);
      afterHash = bytesToBase64(cleaned);
      if (beforeHash === afterHash)
         return;

      this.suppressDirty = true;
      try {
         this.Module.FS.writeFile(abs, cleaned);
      } finally {
         this.suppressDirty = false;
      }
   };

   SaveSync.prototype.buildCurrentManifest = async function() {
      this.cleanupDisallowedLocalFiles();
      this.sanitizeStateLabelsFile();
      var map = {};
      for (var i = 0; i < this.dirs.length; i++)
      {
         var items = this.listTree(this.dirs[i]);
         for (var j = 0; j < items.length; j++)
         {
            var relPath = items[j];
            var data;
            if (!this.shouldSyncRelPath(relPath))
               continue;
            data = this.Module.FS.readFile(pathJoin(this.basePath, relPath), {encoding: "binary"});
            if (isStateDataPath(relPath) && data.length === 0)
            {
               console.warn("[SaveSync] state skipped from current manifest because it is empty", {
                  path: relPath
               });
               continue;
            }
            if (isStateLabelsPath(relPath))
            {
               logStateLabels("local scan before", data, {
                  path: relPath,
                  stateBaseName: this.stateBaseName
               });
               var cleanedLabels = sanitizeStateLabelsBytes(data, this.stateBaseName);
               if (!cleanedLabels)
               {
                  if (syncDebugLogs)
                     console.warn("[SaveSync] state-labels.json skipped from current manifest", {
                        path: relPath,
                        stateBaseName: this.stateBaseName
                     });
                  continue;
               }
               data = cleanedLabels;
               logStateLabels("local scan after", data, {
                  path: relPath,
                  stateBaseName: this.stateBaseName
               });
            }
            map[relPath] = await md5(data);
            logStateFile("local scan", relPath, data, {
               manifestHash: map[relPath]
            });
         }
      }
      return mapToManifest(map);
   };

   SaveSync.prototype.fetchServerManifest = function() {
      var self = this;
      return requestJson(this.apiBase + "/manifest?userId=" + encodeURIComponent(this.userId) +
            "&gameId=" + encodeURIComponent(this.gameId))
         .then(function(data) {
            var meta = manifestMetaFromResponse(data);
            var rawFiles = stripResponseHeaders(meta.files);
            var files = self.filterManifest(rawFiles);
            self.lastRawServerManifest = rawFiles;
            self.lastServerManifestMeta = meta;
            if (syncDebugLogs)
               console.log("[SaveSync] remote manifest", {
                  userId: self.userId,
                  gameId: self.gameId,
                  version: meta.version,
                  updatedAt: meta.updatedAt,
                  entries: meta.entries,
                  files: meta.files
               });
            return files;
         });
   };

   SaveSync.prototype.putServerManifest = function(manifest) {
      var self = this;
      var outgoingMap = manifestToMap(this.filterManifest(manifest));
      var preserved = 0;

      (this.lastRawServerManifest || []).forEach(function(item) {
         if (!item || !item.path || item.hash == null)
            return;
         if (!self.shouldSyncRelPath(item.path))
            return;
         if (!Object.prototype.hasOwnProperty.call(outgoingMap, item.path))
         {
            outgoingMap[item.path] = item.hash;
            preserved++;
         }
      });

      Object.keys(outgoingMap).forEach(function(path) {
         if (outgoingMap[path] == null)
            delete outgoingMap[path];
      });

      manifest = mapToManifest(outgoingMap);
      if (preserved)
         console.warn("[SaveSync] preserving remote manifest entries that local scan did not include", {
            preserved: preserved,
            entries: manifest.length
         });
      return requestJson(this.apiBase + "/manifest?userId=" + encodeURIComponent(this.userId) +
            "&gameId=" + encodeURIComponent(this.gameId), {
         method: "PUT",
         body: JSON.stringify(manifest)
      }).then(function(data) {
         var meta = manifestMetaFromResponse(data);
         var files = self.filterManifest(stripResponseHeaders(meta.files));
         self.lastServerManifestMeta = meta;
         if (syncDebugLogs)
            console.log("[SaveSync] remote manifest updated", {
               userId: self.userId,
               gameId: self.gameId,
               version: meta.version,
               updatedAt: meta.updatedAt,
               entries: meta.entries,
               files: meta.files
            });
         return files;
      });
   };

   SaveSync.prototype.pullFile = async function(relPath) {
      var data = await requestJson(this.apiBase + "/file?userId=" + encodeURIComponent(this.userId) +
            "&gameId=" + encodeURIComponent(this.gameId) +
            "&path=" + encodeURIComponent(relPath));
      var bytes = base64ToBytes(data.data);
      logStateFile("pull remote", relPath, bytes, {
         remoteHash: data.hash
      });
      if (isStateLabelsPath(relPath))
         logStateLabels("pull remote", bytes, {
            path: relPath,
            hash: data.hash
         });
      return bytes;
   };

   SaveSync.prototype.pushFile = async function(relPath) {
      var bytes = this.Module.FS.readFile(pathJoin(this.basePath, relPath), {encoding: "binary"});
      if (isStateDataPath(relPath) && bytes.length === 0)
         throw new Error("refusing to upload zero-byte state: " + relPath);
      logStateFile("push local before upload", relPath, bytes);
      if (isStateDataPath(relPath))
         this.logCoreOptionsSnapshot("before state upload");
      if (isStateLabelsPath(relPath))
      {
         logStateLabels("push before", bytes, {
            path: relPath,
            stateBaseName: this.stateBaseName
         });
         var cleanedLabels = sanitizeStateLabelsBytes(bytes, this.stateBaseName);
         if (cleanedLabels)
         {
            bytes = cleanedLabels;
            logStateLabels("push after", bytes, {
               path: relPath,
               stateBaseName: this.stateBaseName
            });
         }
      }
      var result = await requestJson(this.apiBase + "/file?userId=" + encodeURIComponent(this.userId) +
            "&gameId=" + encodeURIComponent(this.gameId), {
         method: "PUT",
         body: JSON.stringify({
            path: relPath,
            deviceId: this.deviceId,
            data: bytesToBase64(bytes)
         })
      });
      logStateFile("push local uploaded", relPath, bytes, {
         remoteHash: result.hash
      });
      return result.hash;
   };

   SaveSync.prototype.deleteRemoteFile = function(relPath) {
      if (isProtectedRemotePath(relPath))
      {
         console.warn("[SaveSync] refusing to delete protected remote file", relPath);
         return Promise.resolve({path: relPath, protected: true});
      }
      return requestJson(this.apiBase + "/file?userId=" + encodeURIComponent(this.userId) +
            "&gameId=" + encodeURIComponent(this.gameId), {
         method: "DELETE",
         body: JSON.stringify({path: relPath, deviceId: this.deviceId})
      });
   };

   SaveSync.prototype.applyRemoteFile = async function(relPath, hash) {
      var abs = pathJoin(this.basePath, relPath);
      this.suppressDirty = true;
      try {
         if (hash == null)
         {
            if (isProtectedRemotePath(relPath))
            {
               console.warn("[SaveSync] refusing to apply protected remote tombstone", relPath);
               return;
            }
            try {
               this.Module.FS.unlink(abs);
            } catch (e) {}
            return;
         }
         var parent = abs.slice(0, abs.lastIndexOf("/"));
         var bytes = await this.pullFile(relPath);
         this.Module.FS.mkdirTree(parent);
         logStateFile("write local from remote before", relPath, bytes, {
            remoteHash: hash
         });
         this.Module.FS.writeFile(abs, bytes);
         if (isStateDataPath(relPath))
         {
            try {
               var written = this.Module.FS.readFile(abs, {encoding: "binary"});
               logStateFile("write local from remote after", relPath, written, {
                  remoteHash: hash,
                  readBackMatches: md5(written) === md5(bytes)
               });
            } catch (e) {
               console.warn("[SaveSync][state] read-back after remote write failed", {
                  path: relPath,
                  error: e && e.message ? e.message : String(e)
               });
            }
         }
         if (isStateDataPath(relPath))
            this.logCoreOptionsSnapshot("after state download");
         if (isStateLabelsPath(relPath))
            logStateLabels("write local", bytes, {
               path: abs,
               hash: hash
            });
      } finally {
         this.suppressDirty = false;
      }
   };

   SaveSync.prototype.addConflict = function(path, localHash, remoteHash, baseHash, reason) {
      var exists = this.conflicts.some(function(c) {
         return c.path === path && c.status === "pending";
      });
      if (!exists)
      {
         this.conflicts.push({
            id: "conflict-" + Date.now() + "-" + Math.random().toString(16).slice(2),
            path: path,
            reason: reason,
            local: {hash: localHash},
            remote: {hash: remoteHash},
            base: {hash: baseHash},
            status: "pending",
            createdAt: new Date().toISOString()
         });
         this.saveConflicts();
      }
      this.setStatus("conflict", path);
   };

   SaveSync.prototype.getPendingConflicts = function() {
      return (this.conflicts || []).filter(function(conflict) {
         return conflict.status === "pending";
      });
   };

   SaveSync.prototype.conflictCopyPath = function(relPath) {
      var stamp = new Date().toISOString().replace(/[:.]/g, "-");
      var slash = relPath.lastIndexOf("/");
      var dot = relPath.lastIndexOf(".");
      if (dot <= slash)
         return relPath + ".local-conflict." + stamp;
      return relPath.slice(0, dot) + ".local-conflict." + stamp + relPath.slice(dot);
   };

   SaveSync.prototype.resolveConflict = async function(id, action) {
      var conflict = this.conflicts.find(function(item) {
         return item.id === id;
      });
      if (!conflict || conflict.status !== "pending")
         return;

      if (action === "use_remote")
      {
         await this.applyRemoteFile(conflict.path, conflict.remote.hash);
      }
      else if (action === "use_local")
      {
         if (conflict.local.hash == null)
         {
            if (isProtectedRemotePath(conflict.path))
            {
               await this.applyRemoteFile(conflict.path, conflict.remote.hash);
               action = "use_remote";
            }
            else
               await this.deleteRemoteFile(conflict.path);
         }
         else
            conflict.local.hash = await this.pushFile(conflict.path);
      }
      else if (action === "keep_both")
      {
         if (conflict.local.hash != null)
         {
            var copyPath = this.conflictCopyPath(conflict.path);
            var source = this.Module.FS.readFile(pathJoin(this.basePath, conflict.path), {encoding: "binary"});
            var copyAbs = pathJoin(this.basePath, copyPath);
            this.Module.FS.mkdirTree(copyAbs.slice(0, copyAbs.lastIndexOf("/")));
            this.Module.FS.writeFile(copyAbs, source);
         }
         await this.applyRemoteFile(conflict.path, conflict.remote.hash);
      }

      conflict.status = "resolved";
      conflict.resolution = action;
      conflict.resolvedAt = new Date().toISOString();
      this.saveConflicts();

      var serverMap = manifestToMap(await this.fetchServerManifest());
      var localMap = manifestToMap(this.localManifest);
      if (action === "use_remote")
      {
         localMap[conflict.path] = conflict.remote.hash == null ? null : conflict.remote.hash;
      }
      else if (action === "use_local")
      {
         serverMap[conflict.path] = conflict.local.hash == null ? null : conflict.local.hash;
         localMap[conflict.path] = serverMap[conflict.path];
      }
      else if (action === "keep_both")
      {
         localMap[conflict.path] = conflict.remote.hash == null ? null : conflict.remote.hash;
      }
      await this.putServerManifest(mapToManifest(serverMap));
      this.saveLocalManifest(mapToManifest(localMap));
      await this.syncNow();
   };

   SaveSync.prototype.syncNow = async function() {
      if (!this.initialized && !this.Module)
      {
         this.setStatus("sync skipped", "not initialized");
         return;
      }
      if (this.syncing)
      {
         this.setStatus("sync skipped", "already running");
         return;
      }

      this.syncing = true;
      this.setStatus("syncing");
      try {
         var serverMap = manifestToMap(await this.fetchServerManifest());
         var localMap = manifestToMap(this.localManifest);
         var currentMap = manifestToMap(await this.buildCurrentManifest());
         var updatedServer = Object.assign({}, serverMap);
         var updatedLocal = {};
         var paths = {};
         var path;

         for (path in serverMap) paths[path] = true;
         for (path in localMap) paths[path] = true;
         for (path in currentMap) paths[path] = true;

         for (path in paths)
         {
            var serverHas = Object.prototype.hasOwnProperty.call(serverMap, path);
            var localHas = Object.prototype.hasOwnProperty.call(localMap, path);
            var currentHas = Object.prototype.hasOwnProperty.call(currentMap, path);
            var serverHash = serverHas ? serverMap[path] : undefined;
            var localHash = localHas ? localMap[path] : undefined;
            var currentHash = currentHas ? currentMap[path] : undefined;

            if (!localHas)
            {
               if (serverHas && !currentHas)
               {
                  if (serverHash != null)
                     await this.applyRemoteFile(path, serverHash);
                  updatedLocal[path] = serverHash == null ? null : serverHash;
               }
               else if (!serverHas && currentHas)
               {
                  updatedServer[path] = await this.pushFile(path);
                  updatedLocal[path] = updatedServer[path];
               }
               else if (serverHas && currentHas)
               {
                  if (serverHash === currentHash)
                     updatedLocal[path] = currentHash;
                  else
                     this.addConflict(path, currentHash, serverHash, undefined, "untracked-local-vs-remote");
               }
               continue;
            }

            if (serverHas && currentHas)
            {
               var serverChanged = serverHash !== localHash;
               var currentChanged = currentHash !== localHash;

               if (!serverChanged && !currentChanged)
                  updatedLocal[path] = localHash;
               else if (serverChanged && !currentChanged)
               {
                  await this.applyRemoteFile(path, serverHash);
                  updatedLocal[path] = serverHash == null ? null : serverHash;
               }
               else if (!serverChanged && currentChanged)
               {
                  updatedServer[path] = await this.pushFile(path);
                  updatedLocal[path] = updatedServer[path];
               }
               else
                  this.addConflict(path, currentHash, serverHash, localHash, "local-change-vs-remote-change");
               continue;
            }

            if (serverHas && !currentHas)
            {
               if (isProtectedRemotePath(path))
               {
                  if (serverHash != null)
                  {
                     await this.applyRemoteFile(path, serverHash);
                     updatedLocal[path] = serverHash;
                     updatedServer[path] = serverHash;
                  }
                  else
                     updatedLocal[path] = null;
                  continue;
               }

               if (serverHash === localHash)
               {
                  await this.deleteRemoteFile(path);
                  updatedServer[path] = null;
                  updatedLocal[path] = null;
               }
               else if (localHash == null)
                  updatedLocal[path] = serverHash;
               else
                  this.addConflict(path, null, serverHash, localHash, "local-delete-vs-remote-change");
               continue;
            }

            if (!serverHas && currentHas)
            {
               updatedServer[path] = await this.pushFile(path);
               updatedLocal[path] = updatedServer[path];
               continue;
            }

            if (!serverHas && !currentHas)
            {
               updatedServer[path] = null;
               updatedLocal[path] = null;
            }
         }

         if (!manifestMapsEqual(updatedServer, serverMap))
            await this.putServerManifest(mapToManifest(updatedServer));
         this.saveLocalManifest(mapToManifest(updatedLocal));
         this.hasDirtyHint = false;
         this.setStatus(this.getPendingConflicts().length ? "conflict" : "synced",
               "remote " + shortVersion(this.lastServerManifestMeta && this.lastServerManifestMeta.version) +
               " / " + (this.lastServerManifestMeta ? this.lastServerManifestMeta.entries : Object.keys(updatedLocal).length) + " entries");
      } finally {
         this.syncing = false;
      }
   };

   SaveSync.prototype.uploadNow = async function() {
      if (!this.initialized && !this.Module)
      {
         this.setStatus("upload skipped", "not initialized");
         return;
      }
      if (this.syncing)
      {
         this.setStatus("upload skipped", "sync already running");
         return;
      }

      if (this.pendingTimer)
      {
         clearTimeout(this.pendingTimer);
         this.pendingTimer = null;
      }

      this.syncing = true;
      this.setStatus("uploading");
      try {
         var serverMap = manifestToMap(await this.fetchServerManifest());
         var localMap = manifestToMap(this.localManifest);
         var currentMap = manifestToMap(await this.buildCurrentManifest());
         var updatedServer = Object.assign({}, serverMap);
         var updatedLocal = Object.assign({}, localMap);
         var paths = {};
         var path;
         var uploads = 0;
         var deletes = 0;
         var skipped = 0;

         for (path in serverMap) paths[path] = true;
         for (path in localMap) paths[path] = true;
         for (path in currentMap) paths[path] = true;

         for (path in paths)
         {
            var serverHas = Object.prototype.hasOwnProperty.call(serverMap, path);
            var localHas = Object.prototype.hasOwnProperty.call(localMap, path);
            var currentHas = Object.prototype.hasOwnProperty.call(currentMap, path);
            var serverHash = serverHas ? serverMap[path] : undefined;
            var localHash = localHas ? localMap[path] : undefined;
            var currentHash = currentHas ? currentMap[path] : undefined;
            var serverChanged = localHas && serverHash !== localHash;

            if (!localHas && serverHas)
            {
               if (currentHas && currentHash === serverHash)
               {
                  updatedLocal[path] = currentHash;
                  continue;
               }
               this.addConflict(path,
                     currentHas ? currentHash : null,
                     serverHash,
                     undefined,
                     currentHas ? "manual-upload-untracked-local-vs-remote" :
                        "manual-upload-untracked-remote");
               continue;
            }

            if (serverChanged && currentHash !== serverHash)
            {
               this.addConflict(path,
                     currentHas ? currentHash : null,
                     serverHas ? serverHash : undefined,
                     localHash,
                     currentHas ? "manual-upload-local-vs-remote-change" :
                        "manual-upload-delete-vs-remote-change");
               continue;
            }

            if (currentHas)
            {
               if (!serverHas || serverHash !== currentHash)
               {
                  updatedServer[path] = await this.pushFile(path);
                  uploads++;
               }
               else
               {
                  updatedServer[path] = currentHash;
                  skipped++;
               }
               updatedLocal[path] = updatedServer[path];
               continue;
            }

            if (localHas && localHash != null)
            {
               if (isProtectedRemotePath(path))
               {
                  if (serverHas)
                     updatedLocal[path] = serverHash;
                  continue;
               }

               if (serverHas && serverHash != null)
               {
                  await this.deleteRemoteFile(path);
                  deletes++;
               }
               updatedServer[path] = null;
               updatedLocal[path] = null;
               continue;
            }

            if (serverHas && serverHash == null)
               updatedLocal[path] = null;
         }

         if (!manifestMapsEqual(updatedServer, serverMap))
            await this.putServerManifest(mapToManifest(updatedServer));
         this.saveLocalManifest(mapToManifest(updatedLocal));
         this.hasDirtyHint = false;
         this.setStatus(this.getPendingConflicts().length ? "conflict" : "uploaded",
               "remote " + shortVersion(this.lastServerManifestMeta && this.lastServerManifestMeta.version) +
               " / " + (this.lastServerManifestMeta ? this.lastServerManifestMeta.entries : Object.keys(updatedLocal).length) +
               " entries, " + uploads + " uploaded, " + deletes + " deleted, " + skipped + " skipped");
      } finally {
         this.syncing = false;
      }
   };

   SaveSync.prototype.deleteLocalFile = function(relPath) {
      var abs = pathJoin(this.basePath, relPath);
      this.suppressDirty = true;
      try {
         try {
            this.Module.FS.unlink(abs);
         } catch (e) {}
      } finally {
         this.suppressDirty = false;
      }
   };

   SaveSync.prototype.downloadNow = async function() {
      if (!this.initialized && !this.Module)
      {
         console.warn("[SaveSync] download skipped: not initialized", {
            initialized: this.initialized,
            hasModule: !!this.Module
         });
         this.setStatus("download skipped", "not initialized");
         return;
      }
      if (this.syncing)
      {
         console.warn("[SaveSync] download skipped: sync already running");
         this.setStatus("download skipped", "sync already running");
         return;
      }

      if (this.pendingTimer)
      {
         clearTimeout(this.pendingTimer);
         this.pendingTimer = null;
      }

      this.syncing = true;
      this.setStatus("downloading", this.gameId);
      try {
         var serverMap = manifestToMap(await this.fetchServerManifest());
         var currentMap = manifestToMap(await this.buildCurrentManifest());
         var updatedLocal = {};
         var paths = {};
         var path;
         var downloads = 0;
         var deletes = 0;
         var skipped = 0;

         if (syncDebugLogs)
            console.log("[SaveSync] download cloud state", {
               userId: this.userId,
               gameId: this.gameId,
               remoteEntries: Object.keys(serverMap).length,
               localEntries: Object.keys(currentMap).length
            });

         for (path in serverMap) paths[path] = true;
         for (path in currentMap) paths[path] = true;

         for (path in paths)
         {
            var serverHas = Object.prototype.hasOwnProperty.call(serverMap, path);
            var currentHas = Object.prototype.hasOwnProperty.call(currentMap, path);
            var serverHash = serverHas ? serverMap[path] : undefined;
            var currentHash = currentHas ? currentMap[path] : undefined;

            if (serverHas && serverHash != null)
            {
               if (currentHas && currentHash === serverHash)
               {
                  if (syncDebugLogs)
                     console.log("[SaveSync] skipping unchanged remote file", {
                        path: path,
                        hash: serverHash
                     });
                  skipped++;
               }
               else
               {
                  if (syncDebugLogs)
                     console.log("[SaveSync] applying changed remote file", {
                        path: path,
                        hash: serverHash,
                        localHash: currentHash
                     });
                  await this.applyRemoteFile(path, serverHash);
                  downloads++;
               }
               updatedLocal[path] = serverHash;
               continue;
            }

            if (syncDebugLogs)
               console.log("[SaveSync] deleting local file from cloud state", {
                  path: path,
                  serverHas: serverHas,
                  serverHash: serverHash,
                  currentHas: currentHas
               });
            if (isProtectedRemotePath(path))
            {
               console.warn("[SaveSync] refusing to delete protected local file from cloud state", path);
               if (currentHas)
                  updatedLocal[path] = currentHash;
               continue;
            }
            if (currentHas)
            {
               this.deleteLocalFile(path);
               deletes++;
            }
            if (serverHas)
               updatedLocal[path] = null;
         }

         this.conflicts = (this.conflicts || []).map(function(conflict) {
            if (conflict.status === "pending")
            {
               conflict.status = "resolved";
               conflict.resolution = "use_cloud";
               conflict.resolvedAt = new Date().toISOString();
            }
            return conflict;
         });
         this.saveConflicts();
         this.saveLocalManifest(mapToManifest(updatedLocal));
         this.hasDirtyHint = false;
         this.setStatus("downloaded",
               "remote " + shortVersion(this.lastServerManifestMeta && this.lastServerManifestMeta.version) +
               " / " + Object.keys(updatedLocal).length + " entries, " +
               downloads + " downloaded, " + deletes + " deleted, " + skipped + " skipped");
         if (syncDebugLogs)
            console.log("[SaveSync] download complete", {
               userId: this.userId,
               gameId: this.gameId,
               remoteManifestVersion: this.lastServerManifestMeta && this.lastServerManifestMeta.version,
               remoteManifestFiles: this.lastServerManifestMeta && this.lastServerManifestMeta.files,
               localManifestEntries: Object.keys(updatedLocal).length
            });
      } catch (e) {
         console.warn("[SaveSync] download failed", e);
         this.setStatus("download failed", e.message || String(e));
         throw e;
      } finally {
         this.syncing = false;
      }
   };

   var instance = new SaveSync();

   global.RetroArchSaveSync = {
      init: function(options) { return instance.init(options); },
      syncNow: function() { return instance.syncNow(); },
      uploadNow: function() { return instance.uploadNow(); },
      downloadNow: function() { return instance.downloadNow(); },
      setStatus: function(status, detail) { return instance.setStatus(status, detail); },
      markDirty: function(path) {
         instance.hasDirtyHint = true;
         instance.scheduleSync();
      },
      getPendingConflicts: function() { return instance.getPendingConflicts(); },
      resolveConflict: function(id, action) { return instance.resolveConflict(id, action); },
      getState: function() { return instance; }
   };

   global.addEventListener("online", function() {
      instance.syncNow().catch(function(e) {
         instance.setStatus("offline", e.message || String(e));
      });
   });

   global.addEventListener("visibilitychange", function() {
      if (document.visibilityState === "hidden")
         instance.syncNow().catch(function() {});
   });
})(window);
