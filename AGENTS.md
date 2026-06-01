# AGENTS.md

This repository is a RetroArch tree with a local DOSBox Pure core ported for the RetroArch web player. The current runnable web artifacts live under `pkg/emscripten/libretro` and `pkg/emscripten/libretro-thread`.

## Repository Map

- `retroarch.c`, `core.h`, `tasks/`, `frontend/`, `gfx/`, etc.: upstream RetroArch frontend/runtime source.
- `Makefile.emscripten`: Emscripten build entry for producing a web RetroArch frontend linked with one libretro core.
- `pkg/emscripten/README.md`: upstream web-player build and hosting notes.
- `pkg/emscripten/libretro`: single-threaded web player output and static site. This is the active web target for future work.
- `pkg/emscripten/libretro-thread`: pthread/worker-oriented web player output and static site. Do not use this as a development target unless the user explicitly asks; it is considered unstable and out of scope for ongoing work.
- `pkg/emscripten/docker-compose.yml`: local nginx deployment for both web output directories.
- `pkg/emscripten/nginx.conf`: nginx config with cross-origin isolation headers and wasm MIME type.
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

For a typical core, the shape is:

```sh
cd dosbox-pure
emmake make -f Makefile platform=emscripten

cd ..
cp dosbox-pure/dosbox_pure_libretro_emscripten.bc libretro_emscripten.bc
emmake make -f Makefile.emscripten LIBRETRO=dosbox_pure -j all
cp dosbox_pure_libretro.js dosbox_pure_libretro.wasm pkg/emscripten/libretro/
```

Threaded web output is currently out of scope. If it is explicitly needed later, the build shape is:

```sh
emmake make -f Makefile.emscripten LIBRETRO=dosbox_pure PROXY_TO_PTHREAD=1 HAVE_WASMFS=1 -j all
cp dosbox_pure_libretro.js dosbox_pure_libretro.wasm pkg/emscripten/libretro-thread/
```

Notes:

- `pkg/emscripten/README.md` pins the classic single-thread instructions to Emscripten SDK `3.1.46`.
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
