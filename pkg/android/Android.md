# Android Notes

This file records local Android build and packaging knowledge for this
RetroArch tree. Keep `AGENTS.md` as a short index and put detailed Android
notes here.

## Active Targets

- Android Studio/Gradle project: `pkg/android/phoenix`
- Shared Android native build files: `pkg/android/phoenix-common`
- Debug APK output:
  `pkg/android/phoenix/build/outputs/apk/normal/debug/RetroArch-normal-debug-*.apk`

## Known-Good Local Build Environment

The current Android project is old enough that the toolchain versions matter.
The latest verified local debug build used:

- Java 8:
  `/Library/Java/JavaVirtualMachines/adoptopenjdk-8.jdk/Contents/Home`
- Android SDK:
  `/Users/bytedance/Library/Android/sdk`
- Android Gradle Plugin: `4.2.0`
- Gradle wrapper: `6.7.1`
- `compileSdkVersion`: `30`
- `buildToolsVersion`: `30.0.3`
- NDK: `22.0.7026061`

Build command:

```sh
cd pkg/android/phoenix
JAVA_HOME=/Library/Java/JavaVirtualMachines/adoptopenjdk-8.jdk/Contents/Home \
ANDROID_HOME=/Users/bytedance/Library/Android/sdk \
ANDROID_SDK_ROOT=/Users/bytedance/Library/Android/sdk \
./gradlew assembleNormalDebug --stacktrace
```

If signing fails with an invalid debug keystore, move the broken file aside and
regenerate a standard Android debug keystore with Java 8. The previous broken
local keystore was backed up as:

```text
/Users/bytedance/.android/debug.keystore.invalid-20260603-111338
```

## Bundled Assets

The Android GLUI menu needs RetroArch frontend assets at runtime. Without them,
Chinese devices can show `????` text and the bottom tab/icon area can render as
plain black/gray blocks.

The local build currently uses a full copy of `retroarch-assets` under:

```text
pkg/android/phoenix/assets
```

That directory is ignored by git and is local build input. It was created from:

```sh
git clone --depth 1 https://github.com/libretro/retroarch-assets.git /tmp/retroarch-assets-android
rsync -a --exclude .git /tmp/retroarch-assets-android/ pkg/android/phoenix/assets/
```

The full asset copy is large, roughly 278 MB on disk, and makes the debug APK
roughly 269 MB. This is acceptable for the current "make it run first" debug
artifact. For a production-size APK, reduce this to the required menu/font
subset after the Android flow is stable.

Minimum files observed to matter for the current GLUI startup check:

- `pkg/chinese-fallback-font.ttf`
- `glui/main_tab_passive.png`
- `glui/font.ttf`

## Bundled DOSBox Pure Core

The normal debug APK is ARM-only and bundles the verified DOSBox Pure core as
APK assets under:

```text
pkg/android/phoenix/assets/bundled-cores/<abi>/dosbox_pure_libretro_android.so
```

`UserPreferences.updateConfigFile()` installs the matching ABI asset to:

```text
/data/user/0/com.retroarch/cores/dosbox_pure_libretro_android.so
```

This makes fresh APK installs usable on devices without adb sideloading a core.
When replacing the bundled core, update `BUNDLED_DOSBOX_CORE_VERSION` in:

```text
pkg/android/phoenix-common/src/com/retroarch/browser/preferences/util/UserPreferences.java
```

Latest packaged state-aligned core md5 values:

- `arm64-v8a`: `7af19567415593d744c0624b064fd988`
- `armeabi-v7a`: `f7cdcae92457e2ea8afada310d88c048`

The `arm64-v8a` packaged core was verified after a clean emulator install on
June 12, 2026: first launch copied the asset into `cores/` and `md5sum`
reported `7af19567415593d744c0624b064fd988`.

## First-Run Asset Extraction

Android config points RetroArch at app-private extracted assets:

```text
assets_directory = /data/user/0/com.retroarch/assets
```

The project writes bundle extraction settings in:

```text
pkg/android/phoenix-common/src/com/retroarch/browser/preferences/util/UserPreferences.java
```

Important behavior:

- `UserPreferences.updateConfigFile()` verifies required GLUI/font assets in
  app-private storage.
- If assets are missing or the app version changed, Java extracts `assets/*`
  entries from the APK into `/data/user/0/com.retroarch/assets`.
- On success it sets `bundle_assets_extract_enable = false` and records the
  current `bundle_assets_extract_last_version`.
- On failure it leaves C-side bundle extraction enabled and resets
  `bundle_assets_extract_last_version = 0`.

This Java extraction path is intentional. The C-side extraction path is guarded
by `HAVE_COMPRESSION`; without that macro the native bundle extraction code
does not run. Even after enabling the macro, Java-side extraction proved more
reliable for the full APK asset tree.

Native Android CFLAGS therefore need compression enabled in:

```text
pkg/android/phoenix-common/jni/Android.mk
```

Keep `-DHAVE_COMPRESSION` together with the existing zlib/7zip feature flags.

## Failed Extraction Marker

The native bundle extraction completion path lives in:

```text
menu/menu_driver.c
```

Do not mark `bundle_assets_extract_last_version` as complete when extraction
returns an error. If a failed extraction records the current version, future
launches can incorrectly skip extraction and leave the menu without fonts/icons.

## Emulator Verification

Known local AVD:

```text
Medium_Phone_API_36.1
```

Useful commands:

```sh
/Users/bytedance/Library/Android/sdk/emulator/emulator \
  -avd Medium_Phone_API_36.1 -no-snapshot-save -no-audio

/Users/bytedance/Library/Android/sdk/platform-tools/adb \
  -s emulator-5554 install -r -d \
  pkg/android/phoenix/build/outputs/apk/normal/debug/phoenix-normal-debug.apk

/Users/bytedance/Library/Android/sdk/platform-tools/adb \
  -s emulator-5554 shell pm clear com.retroarch

/Users/bytedance/Library/Android/sdk/platform-tools/adb \
  -s emulator-5554 shell cmd locale set-app-locales com.retroarch --locales zh-CN

/Users/bytedance/Library/Android/sdk/platform-tools/adb \
  -s emulator-5554 shell monkey -p com.retroarch 1
```

After first launch, verify extraction:

```sh
/Users/bytedance/Library/Android/sdk/platform-tools/adb \
  -s emulator-5554 shell run-as com.retroarch ls assets/glui/main_tab_passive.png

/Users/bytedance/Library/Android/sdk/platform-tools/adb \
  -s emulator-5554 shell run-as com.retroarch ls assets/pkg/chinese-fallback-font.ttf
```

Successful Chinese-locale verification should show readable Chinese menu labels
such as `菜单`, `加载核心`, and `加载游戏`, not `????`.

The verified screenshot from the local emulator run was:

```text
/tmp/retroarch-android-zh-menu-fixed.png
```

## Android Sync Architecture Notes

Web uses BrowserFS over IndexedDB, but IndexedDB stores implementation-level
inode/data-block keys. Do not sync IndexedDB directly. Sync must operate at
RetroArch virtual path level: saves/states under the mounted userdata tree.

For Android, implement a native/cloud sync driver that talks to the same server
shape as web:

- game identity comes from the canonical static ZIP content hash returned by
  the server game list, not from Android local cache paths
- Android downloads `contentUrl` to local storage and launches the local file
- save/state sync passes the same `gameId` as web
- manifests are arrays of `{ "path": "...", "hash": "..." }`
- MD5 hashes match native RetroArch cloud sync behavior
- deletes are tombstones with `hash: null`
- conflicts use the same three-way comparison:
  server manifest vs last local manifest vs current local files

State labels are cross-platform metadata. Web and Android/native must treat
the following file as a normal synced state file:

```text
states/state-labels.json
```

The file is a JSON object keyed by the same portable state paths used in the
sync manifest, relative to the `states/` sync root:

```json
{
  "DOSBox-pure/sgzyjz.state": "Opening inventory",
  "DOSBox-pure/sgzyjz.state3": "Before boss"
}
```

Do not rename the actual `.state`, `.state1`, `.state2`, etc. files to store
labels. RetroArch derives save-state load paths from numeric slots, so the
metadata file carries display names while the real slot files keep their
RetroArch-compatible names. The metadata file is intentionally not hidden:
native cloud sync does not enumerate hidden files, and Android must not filter
this JSON out when syncing the `states/` tree.

Cookie auth is fine for web. Android should use token-based auth returned by
the server and sent as an authorization header, because Android clients do not
fit the browser cookie/session model cleanly.
