# RetroArch DOSBox Pure Web + Cloud Sync

本项目基于 [RetroArch](https://www.retroarch.com/) / [libretro](https://www.libretro.com/) 生态进行改造，并集成了 [DOSBox Pure](https://github.com/schellingb/dosbox-pure) core，用于在 Web 和 Android 上运行 DOS 游戏，并支持多端存档同步。

首先感谢 RetroArch、libretro、DOSBox Pure 以及相关开源项目的长期维护。本仓库保留 RetroArch 上游代码结构，我们的工作主要集中在 Web Player、Android 端接入、以及一套轻量级 cloud sync 服务。

## 我们做了什么

这个版本的核心目标是让 DOSBox Pure 可以在本地 Web 环境中稳定运行，并让 Web / Android 之间共享同一套云端存档。

主要改动包括：

- DOSBox Pure 跑通到 RetroArch Web Player。
- Web Player 默认使用 `dosbox_pure` core。
- Web 端增加用户注册、登录、登出。
- Web 端增加用户菜单，登录后可使用 `Sync Now`、`Upload Local`、`Use Cloud`。
- 增加轻量级 Node.js sync server，使用 cookie session 做用户鉴权。
- 云端同步按真实用户隔离，不再使用固定用户。
- 云端同步按 `gameId` 隔离，静态部署的游戏 zip 会以内容 hash 作为 canonical game id。
- 同步范围覆盖 RetroArch 的 `saves` 和 `states`。
- Web 端同步逻辑不直接读 IndexedDB，而是通过 Emscripten/BrowserFS 挂载后的虚拟文件路径扫描和同步。
- Android 端增加云账号入口、云游戏列表、下载、sync、upload。
- Android 端使用服务端下发 cookie，并存入 `SharedPreferences` 后随请求带上，尽量复用 Web 的 cookie/session 逻辑。
- Android 端存档目录迁移到 app-specific external storage，避免现代 Android 下公共 `/storage/emulated/0/RetroArch` 权限不稳定。
- 手动 sync / upload 后，Web 和 Android 都会展示远端 manifest version / entries，方便排查多端数据是否一致。

## 当前能力

### Web

Web 产物位于：

```sh
pkg/emscripten/libretro
```

当前主要入口：

```sh
http://localhost:8080/
```

Web 端支持：

- 用户注册 / 登录 / 登出。
- 从用户菜单触发同步。
- 从云端下载存档。
- 上传本地 `saves` / `states`。
- 使用部署在 `assets/games` 下的 DOS 游戏 zip。
- 页面展示同步状态、远端 manifest version 和 entries。

### Android

Android 产物位于：

```sh
pkg/android/phoenix/build/outputs/apk/normal/debug/
```

Android 端支持：

- 云账号登录。
- 下载服务端游戏列表中的 DOS 游戏 zip。
- 将游戏缓存到 app-specific external storage。
- 按同一个 `gameId` 同步 `saves` / `states`。
- 上传本地存档。
- 覆盖安装后继续保留用户数据和云端登录状态。

Android 存储目录使用：

```sh
/storage/emulated/0/Android/data/com.retroarch/files/
```

其中：

```sh
saves/
states/
downloads/
cloud-games/
```

## 云端同步模型

不要直接同步 Web IndexedDB。

Web 端的 IndexedDB 是 BrowserFS 的 inode/data block 结构，不是 RetroArch 可理解的文件路径。同步逻辑应该始终从 RetroArch 挂载后的虚拟路径出发：

```sh
/home/web_user/retroarch/userdata/saves
/home/web_user/retroarch/userdata/states
```

服务端保存的是 cloud_sync-compatible 结构：

```sh
users/<userId>/retroarch/games/<gameId>/objects/
```

典型对象：

```sh
manifest.server
saves/DOSBox-pure/<game>.pure.zip
states/DOSBox-pure/<state-file>
```

manifest 是一个 JSON 数组：

```json
[
  {
    "path": "saves/DOSBox-pure/example.pure.zip",
    "hash": "md5hex"
  }
]
```

说明：

- `path` 是 portable path，固定使用 `/`。
- `hash` 使用 MD5，以便和 RetroArch native cloud sync 模型保持接近。
- 删除使用 tombstone：`hash: null`。
- `gameId` 来自部署游戏 zip 的 `sha256:<hash>`，保证 Web / Android 对同一个游戏使用同一个同步 namespace。

## API 概览

API base：

```sh
/api/sync/v1
```

主要接口：

```sh
POST /auth/register
POST /auth/login
POST /auth/logout
GET  /auth/me

GET  /games

GET  /manifest?gameId=<gameId>
PUT  /manifest?gameId=<gameId>

GET    /file?gameId=<gameId>&path=<path>
PUT    /file?gameId=<gameId>
DELETE /file?gameId=<gameId>&path=<path>
```

`/manifest` 响应会带上调试 header：

```sh
X-RetroArch-Cloud-Manifest-Version
X-RetroArch-Cloud-Manifest-Updated-At
X-RetroArch-Cloud-Manifest-Entries
```

这些 header 用于 Web / Android UI 展示远端版本，方便排查多端是否同步到同一份数据。

## 本地部署

进入 Emscripten 包目录：

```sh
cd pkg/emscripten
docker compose up
```

服务：

```sh
http://localhost:8080/
```

Docker compose 会启动：

- `libretro-nginx`：静态 Web Player。
- `libretro-sync`：Node.js sync server。

数据默认落在：

```sh
pkg/emscripten/sync-data
```

该目录是运行时数据，不应该提交到 git。

## 添加游戏

将 DOS 游戏 zip 放到：

```sh
pkg/emscripten/libretro/assets/games/
```

然后更新：

```sh
pkg/emscripten/libretro/assets/games/.index-xhr
```

简单示例：

```json
{"sgzyjz.zip":null}
```

服务端 `/games` 会扫描 `assets/games/*.zip`，计算 zip 内容 hash，并返回：

- `gameId`
- `title`
- `core`
- `contentUrl`
- `contentHash`
- `contentSize`
- `updatedAt`

Android 会使用 `contentUrl` 下载游戏，并保存 `gameId` 映射，后续同步使用同一个 `gameId`。

## Web 使用方法

1. 启动 Docker 服务。
2. 打开 `http://localhost:8080/`。
3. 通过右上角用户菜单注册或登录。
4. 如需使用云端游戏，选择 `Use Cloud` 或通过云游戏入口下载对应游戏。
5. 运行游戏后，DOSBox Pure 会在 RetroArch 的 save/state 目录下写入存档。
6. 使用用户菜单中的：
   - `Sync Now`：按三方 diff 同步。
   - `Upload Local`：上传本地 saves/states。
   - `Use Cloud`：以云端数据覆盖/恢复本地 saves/states。

## Android 使用方法

1. 安装最新 APK。
2. 打开 RetroArch Cloud。
3. 在 Cloud Account 中登录。
4. 进入 Cloud Games 下载游戏。
5. 从 `Load Content` 中选择下载到本地的游戏 zip。
6. 游戏产生 save/state 后，可使用：
   - `Sync Now`
   - `Upload Local`
   - `Use Cloud`

Android 模拟器访问宿主机 Docker 服务时使用：

```sh
http://10.0.2.2:8080/api/sync/v1
```

真机需要将服务地址改为手机可访问的局域网或公网地址。

## 重新部署时要注意

如果只改 Web UI 或同步 JS，需要替换：

```sh
pkg/emscripten/libretro/index.html
pkg/emscripten/libretro/libretro.css
pkg/emscripten/libretro/libretro.js
pkg/emscripten/libretro/save-sync.js
```

如果改了服务端逻辑，需要替换：

```sh
pkg/emscripten/sync-server.js
```

然后重启服务：

```sh
cd pkg/emscripten
docker compose restart
```

如果只替换静态文件，也建议刷新浏览器缓存。当前 `index.html` 会通过 query version 给 `save-sync.js` / `libretro.js` 做缓存刷新。

## 构建 Android APK

```sh
cd pkg/android/phoenix
JAVA_HOME=/Library/Java/JavaVirtualMachines/adoptopenjdk-8.jdk/Contents/Home \
ANDROID_HOME=/Users/bytedance/Library/Android/sdk \
ANDROID_SDK_ROOT=/Users/bytedance/Library/Android/sdk \
./gradlew assembleNormalDebug --stacktrace
```

APK 输出：

```sh
pkg/android/phoenix/build/outputs/apk/normal/debug/
```

## 重要限制

- 当前 sync server 是轻量级本地服务，适合个人部署和验证，不是完整生产级账号系统。
- session 使用 cookie，Android 端通过 `SharedPreferences` 保存 cookie header。
- Web 当前主目标是 `pkg/emscripten/libretro` 单线程/主 Web Player；`libretro-thread` 暂不作为主要开发目标。
- `states` 同步链路已支持，但建议每个游戏单独做 restore 验证。
- 云端游戏 zip 是 canonical content source；不要用本地路径作为跨端同步 identity。

## 致谢

再次感谢：

- [RetroArch](https://www.retroarch.com/)
- [libretro](https://www.libretro.com/)
- [DOSBox Pure](https://github.com/schellingb/dosbox-pure)
- Emscripten、BrowserFS、Docker、nginx 以及相关开源生态

本项目是在这些基础设施之上做的小步扩展：让 DOSBox Pure 更容易在 Web / Android 多端运行，并让 saves/states 可以围绕真实用户同步。
