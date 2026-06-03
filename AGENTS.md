# AGENTS.md

This repository is a RetroArch tree with a local DOSBox Pure core ported for the RetroArch web player. The current runnable web artifacts live under `pkg/emscripten/libretro` and `pkg/emscripten/libretro-thread`.

## Repository Map

- `retroarch.c`, `core.h`, `tasks/`, `frontend/`, `gfx/`, etc.: upstream RetroArch frontend/runtime source.
- `Makefile.emscripten`: Emscripten build entry for producing a web RetroArch frontend linked with one libretro core.
- `pkg/emscripten/README.md`: upstream web-player build and hosting notes.
- `pkg/emscripten/libretro`: single-threaded web player output and static site. This is the active web target for future work.
- `pkg/emscripten/libretro-thread`: pthread/worker-oriented web player output and static site. Do not use this as a development target unless the user explicitly asks; it is considered unstable and out of scope for ongoing work.
- `pkg/emscripten/docker-compose.yml`: local nginx deployment for both web output directories.
- `pkg/emscripten/nginx.conf`: nginx config with cross-origin isolation headers, wasm MIME type, and `/api/sync/` proxying.
- `pkg/emscripten/sync-server.js`: lightweight local save-sync gateway for the single-thread web player.
- `pkg/android/Android.md`: Android build, asset packaging, Chinese-locale, emulator, and future native sync notes. Read this before Android work.
- `dosbox-pure`: local DOSBox Pure libretro core source.
- `tmp_build/dosbox-pure`: build/source scratch copy. Treat as disposable unless the user says otherwise.

## Current Web Artifacts

The active core is registered as:

```js
const libretroCores = {
  "dosbox_pure": "DOS (DOSBox Pure)"
};
```

Relevant files:

- `pkg/emscripten/libretro/dosbox_pure_libretro.js`
- `pkg/emscripten/libretro/dosbox_pure_libretro.wasm`
- `pkg/emscripten/libretro-thread/dosbox_pure_libretro.js`
- `pkg/emscripten/libretro-thread/dosbox_pure_libretro.wasm`
- `pkg/emscripten/libretro/core_list.js`
- `pkg/emscripten/libretro-thread/core_list.js`

Both web players currently default to `dosbox_pure`. The single-thread player has `autoStart = true`. The threaded player also defaults to auto-start, but should be ignored for future development unless explicitly requested.

## Build Flow

The normal RetroArch web flow is two-stage:

1. Build the libretro core to Emscripten bitcode/static input.
2. Link RetroArch web frontend plus that core with `Makefile.emscripten`.

For a typical core, the upstream shape is:

```sh
cd dosbox-pure
emmake make -f Makefile platform=emscripten

cd ..
cp dosbox-pure/dosbox_pure_libretro_emscripten.bc libretro_emscripten.bc
emmake make -f Makefile.emscripten LIBRETRO=dosbox_pure -j all
cp dosbox_pure_libretro.js dosbox_pure_libretro.wasm pkg/emscripten/libretro/
```

For this DOSBox Pure web port, use the verified build shape below. The
servable target is still the normal single-player directory
`pkg/emscripten/libretro`; do not switch future work to
`pkg/emscripten/libretro-thread`.

Before replacing a known-good deployed core artifact, make a temporary backup:

```sh
backup_dir=/private/tmp/retroarch-core-backup-$(date +%Y%m%d-%H%M%S)
mkdir -p "$backup_dir"
cp pkg/emscripten/libretro/dosbox_pure_libretro.js \
  pkg/emscripten/libretro/dosbox_pure_libretro.wasm \
  "$backup_dir"/
```

Known-good backup from the latest rebuild/debug cycle:

- `/private/tmp/retroarch-core-backup-20260601/dosbox_pure_libretro.good.js`
- `/private/tmp/retroarch-core-backup-20260601/dosbox_pure_libretro.good.wasm`

```sh
/Users/bytedance/tool/emsdk/emsdk activate 3.1.74
source /Users/bytedance/tool/emsdk/emsdk_env.sh

emmake make -C dosbox-pure clean \
  OUTNAME=dosbox_pure_libretro_emscripten.a \
  STATIC_LINKING=1 CXX=em++ AR=emar ISMAC= ISWIN= platform=emscripten

emmake make -C dosbox-pure -j4 \
  OUTNAME=dosbox_pure_libretro_emscripten.a \
  STATIC_LINKING=1 CXX=em++ AR=emar ISMAC= ISWIN= platform=emscripten \
  COMMONFLAGS='-pthread -s SHARED_MEMORY -DDISABLE_DYNAREC=1'

cp dosbox-pure/dosbox_pure_libretro_emscripten.a libretro_emscripten.a
emmake make -f Makefile.emscripten LIBRETRO=dosbox_pure \
  HAVE_THREADS=1 PROXY_TO_PTHREAD=0 clean

cp dosbox-pure/dosbox_pure_libretro_emscripten.a libretro_emscripten.a
emmake make -f Makefile.emscripten LIBRETRO=dosbox_pure \
  HAVE_THREADS=1 PROXY_TO_PTHREAD=0 -j4 all

cp dosbox_pure_libretro.js dosbox_pure_libretro.wasm pkg/emscripten/libretro/
```

This produces a modern Emscripten ES module wrapper with pthread support
(`ENVIRONMENT_IS_PTHREAD`) without proxying the whole RetroArch frontend to a
pthread. Earlier attempts with Emscripten 3.1.46 produced the wrong
wrapper/runtime shape, while Emscripten 4.0.14 produced an FS runtime shape
that is incompatible with the current BrowserFS adapter (`node.fs` errors).
`PROXY_TO_PTHREAD=1` is also the wrong target here.

After copying new artifacts, bump the cache-busting version in:

- `pkg/emscripten/libretro/libretro.js`: `coreAssetVersion`
- `pkg/emscripten/libretro/index.html`: query params for `save-sync.js` and `libretro.js`

The current deployed rebuild uses `20260601-215200`.

Important startup compatibility note: `pkg/emscripten/libretro/libretro.js`
sets the global `Module` to the fresh module object before calling the generated
Emscripten factory. Newer wrappers can invoke `onRuntimeInitialized` before the
factory promise callback assigns its resolved module, and BrowserFS setup needs
`Module.FS`, `Module.PATH`, and `Module.ERRNO_CODES` to already be visible. Do
not remove this early assignment unless the startup sequence is reworked.

Mouse handling note: the known-good web player relies on upstream
RetroArch/Emscripten canvas input behavior for coordinates and deltas, without
pointer lock in normal windowed mode. Do not add custom JavaScript
`requestPointerLock`, `_cmd_toggle_grab_mouse()`, `movementX`/`movementY`, or
canvas coordinate scaling logic in `pkg/emscripten/libretro/libretro.js` unless
the upstream behavior is being deliberately replaced. Both direct JavaScript
pointer lock and the minimal `_cmd_toggle_grab_mouse()` entry point caused
non-fullscreen DOS mouse range drift because C-side `rwebinput` switches to the
pointer-lock `movementX`/`movementY` accumulation path. If pointer lock is
revisited, fix/verify the C-side `input/drivers/rwebinput_input.c` pointer-lock
coordinate path first.

For normal non-pointer-lock mouse movement, `input/drivers/rwebinput_input.c`
maps browser `targetX`/`targetY` from CSS canvas pixels into RetroArch canvas
backing pixels using `emscripten_get_element_css_size("#canvas", ...)` and
`platform_emscripten_get_canvas_size(...)`. Relative `RETRO_DEVICE_MOUSE_X/Y`
deltas are derived from the difference between successive scaled absolute
positions, rather than raw browser `movementX`/`movementY`, so DOSBox Pure gets
movement in the same coordinate space as the rendered canvas. A `mouseleave`
callback resets the previous-position state to avoid a large jump when the
cursor re-enters the canvas. If old local IndexedDB config contains
`input_auto_mouse_grab = "true"`, the web glue restores it to the web default
`false` during startup.

DOSBox Pure in-game mouse sensitivity is a core option, not a browser canvas
coordinate fix. RetroArch's default `global_core_options` is `false`, so the
effective DOSBox Pure option file is normally
`/home/web_user/retroarch/userdata/config/DOSBox-pure/DOSBox-pure.opt`; the web
glue also writes `/home/web_user/retroarch/userdata/retroarch-core-options.cfg`
as a fallback. If `dosbox_pure_mouse_speed_factor` changes appear to have no
effect, confirm the per-core `.opt` path is being written and loaded before
changing `input/drivers/rwebinput_input.c`.

Threaded web output is currently out of scope. If it is explicitly needed later, the build shape is:

```sh
emmake make -f Makefile.emscripten LIBRETRO=dosbox_pure PROXY_TO_PTHREAD=1 HAVE_WASMFS=1 -j all
cp dosbox_pure_libretro.js dosbox_pure_libretro.wasm pkg/emscripten/libretro-thread/
```

Notes:

- `pkg/emscripten/README.md` pins the classic upstream single-thread instructions to Emscripten SDK `3.1.46`; this DOSBox Pure port currently uses Emscripten `3.1.74` with pthread-enabled frontend linking as above.
- The threaded frontend section recommends Emscripten top-of-tree.
- `Makefile.emscripten` expects the core input at repository root as `libretro_emscripten.bc` or `libretro_emscripten.a`.
- DOSBox Pure may need web-specific Makefile support or flags if `platform=emscripten` is not present in the local core Makefile. Check the existing local port before changing the upstream-style platform cases.

## Static Site And Assets

The web player directories are self-contained static sites.

Important asset locations:

- `pkg/emscripten/libretro/assets/frontend`: RetroArch frontend asset bundle split into `bundle.zip.*` parts.
- `pkg/emscripten/libretro/assets/cores/.index-xhr`: BrowserFS index for bundled downloadable core content.
- `pkg/emscripten/libretro/assets/games/sgzyjz.zip`: local DOS game/content sample.
- `pkg/emscripten/libretro/assets/games/.index-xhr`: BrowserFS index for local game content.
- `pkg/emscripten/libretro-thread/assets/games/sgzyjz.zip`: threaded player sample content.

When adding files under `assets/cores` or `assets/games`, update the matching `.index-xhr`. The upstream indexer workflow is documented in `pkg/emscripten/README.md`; the current simple games index is JSON shaped like:

```json
{"sgzyjz.zip":null}
```

## Runtime File System

Future web work should target the single-thread player only. It uses BrowserFS in `pkg/emscripten/libretro/libretro.js`:

- mounts the frontend bundle under `/home/web_user/retroarch`
- mounts in-memory fake core files under `/home/web_user/retroarch/cores`
- mounts persistent userdata under `/home/web_user/retroarch/userdata`
- mounts XHR core content under `/home/web_user/retroarch/userdata/content/downloads`
- mounts XHR game content under `/home/web_user/retroarch/userdata/content/games`

Do not inspect or synchronize BrowserFS' IndexedDB object store directly. IndexedDB keys are BrowserFS inode/data block ids (including UUIDs), not RetroArch file paths. Save synchronization must use the mounted virtual paths through `Module.FS`.

## Save Sync

The active save-sync MVP is single-thread only:

- frontend module: `pkg/emscripten/libretro/save-sync.js`
- sync API gateway: `pkg/emscripten/sync-server.js`
- fixed initial user namespace: `userId = "1"`
- game namespace: `gameId` is derived from the deployed static ZIP content hash when available
- synced virtual paths: `/home/web_user/retroarch/userdata/saves` and `/home/web_user/retroarch/userdata/states`
- local persistence remains BrowserFS `AsyncMirror(InMemory + IndexedDB)`, so offline play remains available

RetroArch provides practical game separation via its save/state path policy, not via BrowserFS itself. On Emscripten, default save/state roots are `userdata/saves` and `userdata/states`; default `sort_savefiles_enable` and `sort_savestates_enable` place files under the core name, with filenames based on the loaded content basename. The sync layer mirrors this tree inside a per-game cloud namespace.

Static deployed games are the canonical content source. The sync gateway exposes `GET /api/sync/v1/games`, scanning `pkg/emscripten/libretro/assets/games/*.zip` and returning metadata including:

- `gameId`: `sha256:<zip-content-hash>`
- `contentUrl`: `/assets/games/<file>.zip`
- `contentHash`, `contentSize`, `title`, and `core`

Android/native clients should download `contentUrl` to a local cache and launch that local file. Save/state sync must pass the same `gameId`, so local Android cache paths do not affect cross-device save identity.

The sync protocol should stay close to RetroArch's native `task_cloudsync.c` model so Android/native support can share the same backend:

- server manifest is a JSON array of `{ "path": "...", "hash": "..." }`
- local manifest is the last successfully synced copy of that same array
- current manifest is built by scanning the mounted virtual paths
- hashes are MD5 strings to match native cloud_sync
- deletes are tombstones represented by `hash: null`; do not simply remove manifest entries
- conflicts are detected via the same three-way comparison: server manifest vs last local manifest vs current local files
- conflicts are recorded as pending client-side conflict records for later user resolution; do not silently overwrite either side

The local sync gateway stores objects and a `manifest.server` object under `users/<userId>/retroarch/games/<gameId>/`. This shape is intentionally close to the existing `cloud_sync_driver_t` operations (`read`, `update`, `free`) so a native Android driver can later map those operations to the same service.

The local sync gateway writes data under `pkg/emscripten/sync-data` by default when run outside Docker, and `/data` in Docker. This directory is ignored by git.

The threaded player uses `pkg/emscripten/libretro-thread/libretro.js` and includes `jsdeps/browserfs.min.js`, but this target is currently unstable and should not drive new feature work. For reference only, it mounts game XHR content after the WASM runtime and worker FS are initialized, including:

- `/home/web_user/retroarch/content/games`
- `/home/web_user/retroarch/userdata/content/games`
- `/retroarch/content/games`
- `/retroarch/userdata/content/games`

There is a guard (`appInitializedStarted`) to avoid duplicate runtime initialization.

## Local Deployment

From `pkg/emscripten`, the docker compose file starts two nginx instances:

```sh
docker compose up
```

Ports:

- `http://localhost:8080/` serves `pkg/emscripten/libretro`
- `http://localhost:8081/` serves `pkg/emscripten/libretro-thread` for reference only; do not use it as the main validation target.
- `/api/sync/v1/*` on the nginx host proxies to the `sync` service.

`nginx.conf` sets:

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`
- `Cross-Origin-Resource-Policy: same-origin`
- `application/wasm` for `.wasm`

These headers are required for threaded/isolated browser execution.

## Development Notes

- Prefer editing the web-player glue in `pkg/emscripten/libretro*.js` only when the issue is browser loading, FS mounting, asset discovery, or startup behavior.
- Prefer editing `dosbox-pure` only when the issue is core behavior, libretro API behavior, DOSBox Pure options, serialization, input, or Emscripten compatibility inside the core.
- Do not treat generated `.js`/`.wasm` artifacts as source of truth. Rebuild them when core or RetroArch C/C++ code changes.
- `cert.pem` and `key.pem` are local development certificates in `pkg/emscripten/libretro`; avoid relying on them for production deployment.
- There are existing untracked/generated files in this workspace. Do not delete or reset them without explicit user direction.

## Quick Verification

After rebuilding or changing web glue:

1. Start nginx from `pkg/emscripten`.
2. Open `http://localhost:8080/` for the supported single-thread web player.
3. Confirm the core list shows `DOS (DOSBox Pure)`.
4. Confirm the browser loads `dosbox_pure_libretro.js` and `.wasm` without MIME/CORS errors.
5. Confirm `assets/games/sgzyjz.zip` is visible/loadable from the web player content path.
6. Ignore `libretro-thread` unless the user explicitly reopens that target.

Useful successful startup signals from browser console:

- `WEBPLAYER: loading core ... dosbox_pure_libretro.js?v=<version>`
- `WEBPLAYER: appInitialized ... hasModule: true, hasCallMain: true`
- `WEBPLAYER: mountBrowserFS called ... hasModuleFS: true`
- `WEBPLAYER: filesystem initialization successful`
- `WEBPLAYER: callMain requested`
- `RetroArch 1.22.2`
- `[GL] Found GL context: "webgl_emscripten".`
- `[Audio] Started synchronous audio driver.`
- `WEBPLAYER: callMain returned`

The log `[Core info] Failed to write core info cache file:
"/home/web_user/retroarch/bundle/info/core_info.cache"` is expected with the
read-only bundled asset mount and is not by itself a startup failure.
