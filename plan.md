# RetroArch Web/Android Save Sync Plan

## Goal

Make the current web save-sync backend usable by both the web player and a future Android RetroArch build.

The shared contract should be based on RetroArch portable sync semantics, not on any platform's local storage format.

- Web local storage: BrowserFS over IndexedDB.
- Android local storage: native filesystem or SAF.
- Cloud storage: user/game namespace plus portable paths such as `saves/...` and `states/...`.

IndexedDB keys, Android absolute file paths, and SAF URIs must never become cloud object paths.

## Current Server Shape

The web sync gateway stores data under:

```text
sync-data/
  users/
    <userId>/
      retroarch/
        games/
          <gameId>/
            objects/
              manifest.server
              saves/...
              states/...
            _deleted/
              saves/...<timestamp>
```

The server manifest is:

```json
[
  { "path": "saves/DOSBox-pure/example.srm", "hash": "md5hex" },
  { "path": "states/DOSBox-pure/example.state", "hash": "md5hex" },
  { "path": "saves/DOSBox-pure/deleted.srm", "hash": null }
]
```

This is already close to RetroArch native `task_cloudsync.c`:

- `path` is portable and relative.
- `hash` is MD5.
- `hash: null` is a tombstone.
- Per-game namespace is keyed by `gameId`.

## Compatibility Rules

### User Namespace

All sync operations must resolve a real authenticated user.

Web should continue using an HttpOnly cookie:

```http
Cookie: retroarch_session=...
```

Android MVP should reuse the same cookie session model instead of adding a
separate token protocol immediately. The Android login client can read the
`Set-Cookie` response header, store the `retroarch_session` value locally, and
send it on later requests:

```http
Cookie: retroarch_session=<session>
```

`HttpOnly` only prevents browser JavaScript from reading the cookie. It does
not prevent an Android native HTTP client from receiving and storing the
`Set-Cookie` header.

The server already stores sessions as:

```text
sha256(session-token) -> userId, username, createdAt, expiresAt
```

For MVP, Android can store the cookie in app-private `SharedPreferences`.
This is simple and enough to validate the flow. The value is still a bearer
secret, so do not write it to `retroarch.cfg` or other user-exportable files.
Later hardening can move it to Android Keystore or encrypted preferences.

### Game Namespace

The same game must have the same `gameId` on every client.

For static deployed games, the canonical `gameId` is:

```text
sha256:<zip-content-hash>
```

Android should not use its local cache path as identity. It should:

1. Call `GET /api/sync/v1/games`.
2. Download `contentUrl`.
3. Verify or record `contentHash`.
4. Launch the local cached file.
5. Sync with `gameId = contentHash`.

### Portable Paths

All clients must sync portable RetroArch-relative paths:

```text
saves/...
states/...
config/...
system/...
thumbnails/...
```

Examples:

```text
saves/DOSBox-pure/sgzyjz.srm
states/DOSBox-pure/sgzyjz.state
```

Platform-specific local paths are implementation details:

```text
Web:
  /home/web_user/retroarch/userdata/saves/...

Android:
  /data/user/0/<package>/files/RetroArch/saves/...
  /storage/emulated/0/RetroArch/saves/...
  SAF uri backed files
```

## Server Changes

### 1. MVP: Keep Existing Cookie Auth

The current server auth endpoints can be reused unchanged:

```text
POST /api/sync/v1/auth/register
POST /api/sync/v1/auth/login
GET  /api/sync/v1/auth/me
POST /api/sync/v1/auth/logout
```

Login/register already return:

```json
{
  "user": {
    "userId": "alice",
    "username": "alice"
  }
}
```

and set:

```http
Set-Cookie: retroarch_session=...; HttpOnly; SameSite=Lax; Path=/api/sync/v1
```

Android should:

1. POST username/password to `/auth/login` or `/auth/register`.
2. Parse `Set-Cookie`.
3. Persist the `retroarch_session` cookie in `SharedPreferences`.
4. Send `Cookie: retroarch_session=<session>` on `/auth/me`, `/manifest`,
   `/file`, and `/auth/logout`.
5. Clear the saved cookie on logout or when `/auth/me` returns unauthorized.

This avoids service-side token work while still using real authenticated users.

### 2. Future: Bearer Token Auth

Bearer tokens are not required for Android MVP. They can be added later if the
project wants a more explicit native-client auth contract.

Potential future endpoint:

```text
POST /api/sync/v1/auth/token
```

Request:

```json
{
  "username": "alice",
  "password": "secret"
}
```

Response:

```json
{
  "token": "<bearer-token>",
  "expiresAt": "2026-07-03T00:00:00.000Z",
  "user": {
    "userId": "alice",
    "username": "alice"
  }
}
```

Potential future auth resolver:

1. Check `Authorization: Bearer <token>`.
2. If absent, check `Cookie: retroarch_session=...`.
3. Validate token hash in `sessions.json`.
4. Return authenticated user.

### 3. MVP: Keep Existing JSON/Base64 File Endpoint

The current file endpoint is enough for Android MVP:

```text
GET    /api/sync/v1/file?gameId=...&path=...
PUT    /api/sync/v1/file?gameId=...
DELETE /api/sync/v1/file?gameId=...
```

`GET` returns JSON with base64 file data:

```json
{
  "path": "saves/DOSBox-pure/example.srm",
  "hash": "<md5hex>",
  "data": "<base64>"
}
```

`PUT` accepts JSON with base64 file data:

```json
{
  "path": "saves/DOSBox-pure/example.srm",
  "data": "<base64>"
}
```

This adds size and memory overhead for large savestates, but it avoids server
changes while validating the cross-device sync model.

### 4. Future: Raw File Endpoint

A raw binary endpoint is a performance optimization, not an MVP blocker.

Potential future endpoint:

```text
GET /api/sync/v1/file/raw?gameId=...&path=<portable-path>
PUT /api/sync/v1/file/raw?gameId=...&path=<portable-path>
```

`GET` response:

```http
200 OK
Content-Type: application/octet-stream
X-File-Path: saves/DOSBox-pure/example.srm
X-File-Hash: <md5hex>

<raw bytes>
```

`PUT` request:

```http
PUT /api/sync/v1/file/raw?gameId=...&path=saves/DOSBox-pure/example.srm
Content-Type: application/octet-stream
Cookie: retroarch_session=<session>

<raw bytes>
```

`PUT` response:

```json
{
  "path": "saves/DOSBox-pure/example.srm",
  "hash": "<md5hex>"
}
```

Benefits:

- Avoids base64 size overhead.
- Avoids JSON parsing large savestate payloads.
- Allows native client code to stream file data.

### 5. Manifest API

Current API can stay:

```text
GET /api/sync/v1/manifest?gameId=...
PUT /api/sync/v1/manifest?gameId=...
```

Request and response body:

```json
[
  { "path": "saves/DOSBox-pure/example.srm", "hash": "<md5hex>" }
]
```

Potential future hardening:

- Add `revision` or `etag` to detect concurrent manifest updates.
- Support `If-Match` for optimistic concurrency.
- Keep tombstones for a retention period before compaction.

Do not block Android MVP on these.

### 6. Games API

Current API can stay:

```text
GET /api/sync/v1/games
```

Response item:

```json
{
  "gameId": "sha256:<zip-content-hash>",
  "title": "sgzyjz",
  "core": "dosbox_pure",
  "fileName": "sgzyjz.zip",
  "contentUrl": "/assets/games/sgzyjz.zip",
  "contentHash": "sha256:<zip-content-hash>",
  "contentSize": 123456,
  "updatedAt": "2026-06-03T00:00:00.000Z"
}
```

Android should use this as the source of truth for content identity.

## Android Implementation Plan

### High-Level Shape

Do not reuse web IndexedDB logic.

Add a native RetroArch cloud sync driver:

```text
network/cloud_sync/retroarch_sync.c
```

Driver ident:

```text
retroarch_sync
```

Register it in:

```text
network/cloud_sync_driver.c
network/cloud_sync_driver.h
```

Make Android builds include the new source and driver.

### Driver Contract

RetroArch already has:

```c
typedef struct cloud_sync_driver
{
   bool (*cloud_sync_begin)(cloud_sync_complete_handler_t cb, void *user_data);
   bool (*cloud_sync_end)(cloud_sync_complete_handler_t cb, void *user_data);
   bool (*cloud_sync_read)(const char *path, const char *file, cloud_sync_complete_handler_t cb, void *user_data);
   bool (*cloud_sync_update)(const char *path, RFILE *file, cloud_sync_complete_handler_t cb, void *user_data);
   bool (*cloud_sync_free)(const char *path, cloud_sync_complete_handler_t cb, void *user_data);
   const char *ident;
} cloud_sync_driver_t;
```

Map it to the sync service:

| Driver Method | Server API |
| --- | --- |
| `begin` | validate auth/session, optional no-op |
| `read("manifest.server", file)` | `GET /manifest?gameId=...` |
| `read(path, file)` | MVP: `GET /file?gameId=...&path=...`, decode base64 |
| `update("manifest.server", file)` | `PUT /manifest?gameId=...` |
| `update(path, file)` | MVP: `PUT /file?gameId=...`, encode base64 |
| `free(path)` | `DELETE /file?gameId=...` |
| `end` | optional no-op |

`task_cloudsync.c` remains responsible for:

- Scanning local saves/states/config/system/thumbnails.
- Building current manifest.
- Reading local manifest.
- Three-way diff.
- MD5 calculation.
- Tombstones and conflicts.

The new driver only transports portable files to and from the server.

### Android Auth UI

Add a simple Android UI path for:

- username
- password
- login
- register or link to register
- logout

For MVP, use Java-side login/register/logout and app-private
`SharedPreferences`.

Suggested helper:

```text
CloudAuthManager
```

Responsibilities:

- `login(username, password)`: POST `/auth/login`, capture `Set-Cookie`.
- `register(username, password)`: POST `/auth/register`, capture `Set-Cookie`.
- `logout()`: POST `/auth/logout` with saved cookie, then clear local state.
- `me()`: GET `/auth/me` with saved cookie.
- `getCookieHeader()`: return `Cookie: retroarch_session=<session>`.

Suggested `SharedPreferences` fields:

```text
cloud_sync_server_url
cloud_sync_username
cloud_sync_session_cookie
cloud_sync_session_expires_at
```

`cloud_sync_session_cookie` may store either the cookie value or a complete
`retroarch_session=<session>` pair. Do not store the cookie in `retroarch.cfg`.

Future hardening can move the cookie to Android Keystore or
EncryptedSharedPreferences.

Expose settings:

```text
sync server base url
logged-in username
login/logout
sync now
```

### Android Game Flow

For static games:

1. Login.
2. Call `GET /api/sync/v1/games`.
3. Present/download game.
4. Store downloaded zip in Android app cache or selected storage.
5. Launch local file in RetroArch.
6. Store selected `gameId` alongside the local cache entry.
7. Sync using that `gameId`.

For user-imported content later:

- Define a server-side content registration flow.
- Compute content hash locally.
- Use same `sha256:<content-hash>` convention.

Do not mix local Android path into `gameId`.

### Android FS Mapping

Use RetroArch's existing save/state directories:

- `RARCH_DIR_SAVEFILE`
- `RARCH_DIR_SAVESTATE`

Native `task_cloudsync.c` already maps directories into portable roots:

```text
saves
states
config
system
thumbnails
```

The driver should not transform file paths except URL encoding.

## Implementation Phases

### Phase 1: Server Baseline

No server changes are required for the Android MVP.

Validate the existing endpoints:

- cookie web login/register/logout
- Android-style login that captures `Set-Cookie`
- `/auth/me` with manually supplied `Cookie:` header
- manifest read/write with manually supplied `Cookie:` header
- JSON/base64 file upload/download/delete with manually supplied `Cookie:`
  header
- cross-user access denied
- path traversal rejected

Future protocol hardening can add bearer tokens and raw file endpoints after
the MVP works end-to-end.

### Phase 2: Android Build Baseline

- Prepare SDK/NDK/JDK environment.
- Build the existing Android RetroArch APK without sync changes.
- Build DOSBox Pure Android core `.so`.
- Decide whether the core is bundled, sideloaded, or downloaded.

### Phase 3: Android Auth And Settings

- Add sync server URL setting.
- Add login/register UI.
- Persist the `retroarch_session` cookie in `SharedPreferences`.
- Add logout.
- Validate `/auth/me`.
- Surface logged-in username/status in the UI.

### Phase 4: Android `retroarch_sync` Driver

- Add driver source.
- Register driver.
- Implement manifest transport.
- Implement JSON/base64 file read/update/free against `/file`.
- Wire saved cookie header and `gameId`.
- Verify native `task_cloudsync.c` can sync saves/states to the same server namespace as web.

### Phase 4.5: Optional Protocol Optimization

- Add `/auth/token` if Android should stop reusing cookies.
- Add bearer token support in the server auth resolver.
- Add `/file/raw` for lower overhead savestate transfer.
- Update `retroarch_sync` to stream raw files instead of base64 JSON.

### Phase 5: End-To-End Cross-Device Test

Test matrix:

1. Web creates save -> Android downloads same save.
2. Android updates save -> Web downloads same save.
3. Web and Android both modify -> conflict is detected, not silently overwritten.
4. Delete on one side -> tombstone propagates.
5. Different users cannot see each other's saves.
6. Same content hash maps to same `gameId` even with different local paths.

## Open Questions

- Should Android use only saves/states for MVP, or also expose config/system/thumbnails?
- Should `gameId` be selected globally, per running content, or stored in playlist/content metadata?
- How should Android surface conflicts? Existing RetroArch cloud sync may log conflicts but may need better UI.
- Should the server add manifest revisions before Android ships, or wait until real concurrency issues appear?
- How should production HTTPS and secure cookie rotation be configured?
