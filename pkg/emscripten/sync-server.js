"use strict";

const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.SYNC_PORT || 8787);
const ROOT = path.resolve(process.env.SYNC_DATA_DIR || path.join(__dirname, "sync-data"));
const GAMES_DIR = path.resolve(process.env.SYNC_GAMES_DIR || path.join(__dirname, "libretro", "assets", "games"));
const DEFAULT_GAME_ID = "default";
const MANIFEST_FILE = "manifest.server";
const USERS_FILE = path.join(ROOT, "auth", "users.json");
const SESSIONS_FILE = path.join(ROOT, "auth", "sessions.json");
const SESSION_COOKIE = "retroarch_session";
const TOKEN_BYTES = 32;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

function sendJson(res, status, body, extraHeaders) {
  const text = JSON.stringify(body == null ? {} : body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...(extraHeaders || {})
  });
  res.end(text);
}

function sanitizeUserId(userId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(userId))
    throw new Error("invalid userId");
  return userId;
}

function normalizeUsername(username) {
  username = String(username || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(username))
    throw new Error("username must be 3-32 characters: letters, numbers, _ or -");
  return username;
}

function sanitizePassword(password) {
  password = String(password || "");
  if (password.length < 6 || password.length > 128)
    throw new Error("password must be 6-128 characters");
  return password;
}

function sanitizeGameId(gameId) {
  gameId = gameId || DEFAULT_GAME_ID;
  if (!/^[a-zA-Z0-9:._-]+$/.test(gameId))
    throw new Error("invalid gameId");
  return gameId;
}

function sanitizeRelPath(relPath) {
  if (!relPath || typeof relPath !== "string")
    throw new Error("missing path");
  relPath = relPath.replace(/^\/+/, "");
  const normalized = path.posix.normalize(relPath);
  if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../"))
    throw new Error("invalid path");
  if (normalized !== MANIFEST_FILE && !/^(saves|states|config|system|thumbnails)\//.test(normalized))
    throw new Error("path is outside cloud_sync roots");
  return normalized;
}

function userRoot(userId) {
  return path.join(ROOT, "users", userId, "retroarch");
}

function gameRoot(userId, gameId) {
  return path.join(userRoot(userId), "games", gameId);
}

function objectPath(userId, gameId, relPath) {
  return path.join(gameRoot(userId, gameId), "objects", relPath);
}

function deletedPath(userId, gameId, relPath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(gameRoot(userId, gameId), "_deleted", `${relPath}.${stamp}`);
}

function hashBytes(buffer) {
  return crypto.createHash("md5").update(buffer).digest("hex");
}

function hashContent(buffer) {
  return `sha256:${crypto.createHash("sha256").update(buffer).digest("hex")}`;
}

function normalizeManifest(value) {
  if (!Array.isArray(value))
    throw new Error("manifest must be an array");
  return value.map(item => {
    const relPath = sanitizeRelPath(item.path);
    if (relPath === MANIFEST_FILE)
      throw new Error("manifest cannot include itself");
    if (item.hash != null && !/^[a-fA-F0-9]{32}$/.test(item.hash))
      throw new Error(`invalid hash for ${relPath}`);
    return {path: relPath, hash: item.hash == null ? null : item.hash.toLowerCase()};
  }).sort((a, b) => a.path.localeCompare(b.path));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req)
    chunks.push(chunk);
  if (!chunks.length)
    return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT")
      return fallback;
    throw e;
  }
}

async function writeJsonFile(file, data) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

function userPublic(user) {
  return {
    userId: user.id,
    username: user.username,
    createdAt: user.createdAt
  };
}

function passwordHash(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 150000, 32, "sha256").toString("hex");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function findUserByUsername(username) {
  const users = await readJsonFile(USERS_FILE, {users: []});
  return {users, user: users.users.find(item => item.username === username)};
}

async function createSession(user) {
  const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  const sessions = await readJsonFile(SESSIONS_FILE, {sessions: {}});
  sessions.sessions[hashToken(token)] = {
    userId: user.id,
    username: user.username,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString()
  };
  await writeJsonFile(SESSIONS_FILE, sessions);
  return token;
}

function parseCookies(req) {
  return String(req.headers.cookie || "").split(";").reduce((cookies, item) => {
    const idx = item.indexOf("=");
    if (idx < 0)
      return cookies;
    const key = item.slice(0, idx).trim();
    const value = item.slice(idx + 1).trim();
    if (key)
      cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function sessionCookie(token) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/api/sync/v1; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/api/sync/v1; Max-Age=0; HttpOnly; SameSite=Lax`;
}

async function requireUser(req, url) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token)
    throw Object.assign(new Error("login required"), {statusCode: 401});

  const sessions = await readJsonFile(SESSIONS_FILE, {sessions: {}});
  const session = sessions.sessions[hashToken(token)];
  if (!session)
    throw Object.assign(new Error("invalid session"), {statusCode: 401});
  if (Date.parse(session.expiresAt) <= Date.now())
  {
    delete sessions.sessions[hashToken(token)];
    await writeJsonFile(SESSIONS_FILE, sessions);
    throw Object.assign(new Error("session expired"), {statusCode: 401});
  }

  const requestedUserId = url.searchParams.get("userId");
  if (requestedUserId && requestedUserId !== session.userId)
    throw Object.assign(new Error("session does not match userId"), {statusCode: 403});

  return {
    id: sanitizeUserId(session.userId),
    username: session.username
  };
}

async function handleRegister(req, res) {
  if (req.method !== "POST")
    return sendJson(res, 405, {error: "method not allowed"});
  const body = await readBody(req);
  const username = normalizeUsername(body.username);
  const password = sanitizePassword(body.password);
  const {users, user} = await findUserByUsername(username);
  if (user)
    return sendJson(res, 409, {error: "user already exists"});

  const salt = crypto.randomBytes(16).toString("hex");
  const newUser = {
    id: username,
    username,
    salt,
    passwordHash: passwordHash(password, salt),
    createdAt: new Date().toISOString()
  };
  users.users.push(newUser);
  users.users.sort((a, b) => a.username.localeCompare(b.username));
  await writeJsonFile(USERS_FILE, users);
  const token = await createSession(newUser);
  sendJson(res, 200, {user: userPublic(newUser)}, {"Set-Cookie": sessionCookie(token)});
}

async function handleLogin(req, res) {
  if (req.method !== "POST")
    return sendJson(res, 405, {error: "method not allowed"});
  const body = await readBody(req);
  const username = normalizeUsername(body.username);
  const password = sanitizePassword(body.password);
  const {user} = await findUserByUsername(username);
  if (!user || user.passwordHash !== passwordHash(password, user.salt))
    return sendJson(res, 401, {error: "invalid username or password"});

  const token = await createSession(user);
  sendJson(res, 200, {user: userPublic(user)}, {"Set-Cookie": sessionCookie(token)});
}

async function handleMe(req, res, url) {
  if (req.method !== "GET")
    return sendJson(res, 405, {error: "method not allowed"});
  const user = await requireUser(req, url);
  sendJson(res, 200, {user: {userId: user.id, username: user.username}});
}

async function handleLogout(req, res) {
  if (req.method !== "POST")
    return sendJson(res, 405, {error: "method not allowed"});
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token)
  {
    const sessions = await readJsonFile(SESSIONS_FILE, {sessions: {}});
    delete sessions.sessions[hashToken(token)];
    await writeJsonFile(SESSIONS_FILE, sessions);
  }
  sendJson(res, 200, {ok: true}, {"Set-Cookie": clearSessionCookie()});
}

async function readManifest(userId, gameId) {
  try {
    return JSON.parse(await fs.readFile(objectPath(userId, gameId, MANIFEST_FILE), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT")
      return [];
    throw e;
  }
}

async function writeManifest(userId, gameId, manifest) {
  manifest = normalizeManifest(manifest);
  const file = objectPath(userId, gameId, MANIFEST_FILE);
  await fs.mkdir(path.dirname(file), {recursive: true});
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(manifest, null, 2));
  await fs.rename(tmp, file);
  return manifest;
}

async function handleManifest(req, res, url) {
  const userId = (await requireUser(req, url)).id;
  const gameId = sanitizeGameId(url.searchParams.get("gameId"));
  if (req.method === "GET")
    return sendJson(res, 200, await readManifest(userId, gameId));
  if (req.method === "PUT")
    return sendJson(res, 200, await writeManifest(userId, gameId, await readBody(req)));
  sendJson(res, 405, {error: "method not allowed"});
}

async function handleGetFile(req, res, url) {
  const userId = (await requireUser(req, url)).id;
  const gameId = sanitizeGameId(url.searchParams.get("gameId"));
  const relPath = sanitizeRelPath(url.searchParams.get("path"));
  if (relPath === MANIFEST_FILE)
    return sendJson(res, 200, await readManifest(userId, gameId));

  try {
    const data = await fs.readFile(objectPath(userId, gameId, relPath));
    sendJson(res, 200, {
      path: relPath,
      hash: hashBytes(data),
      data: data.toString("base64")
    });
  } catch (e) {
    if (e.code === "ENOENT")
      return sendJson(res, 404, {error: "file not found"});
    throw e;
  }
}

async function handlePutFile(req, res, url) {
  const userId = (await requireUser(req, url)).id;
  const gameId = sanitizeGameId(url.searchParams.get("gameId"));
  const body = await readBody(req);
  const relPath = sanitizeRelPath(body.path);
  if (relPath === MANIFEST_FILE)
    return sendJson(res, 200, await writeManifest(userId, gameId, body.manifest || body));

  const data = Buffer.from(body.data || "", "base64");
  const hash = hashBytes(data);
  const file = objectPath(userId, gameId, relPath);
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, data);
  sendJson(res, 200, {path: relPath, hash});
}

async function handleDeleteFile(req, res, url) {
  const userId = (await requireUser(req, url)).id;
  const gameId = sanitizeGameId(url.searchParams.get("gameId"));
  const body = await readBody(req);
  const relPath = sanitizeRelPath(body.path || url.searchParams.get("path"));
  if (relPath === MANIFEST_FILE)
    return sendJson(res, 400, {error: "cannot delete manifest through file endpoint"});

  const source = objectPath(userId, gameId, relPath);
  try {
    const dest = deletedPath(userId, gameId, relPath);
    await fs.mkdir(path.dirname(dest), {recursive: true});
    await fs.rename(source, dest);
  } catch (e) {
    if (e.code !== "ENOENT")
      throw e;
  }
  sendJson(res, 200, {path: relPath, deleted: true});
}

async function handleGames(req, res) {
  if (req.method !== "GET")
    return sendJson(res, 405, {error: "method not allowed"});

  let entries;
  try {
    entries = await fs.readdir(GAMES_DIR, {withFileTypes: true});
  } catch (e) {
    if (e.code === "ENOENT")
      return sendJson(res, 200, []);
    throw e;
  }

  const games = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".zip"))
      continue;
    const file = path.join(GAMES_DIR, entry.name);
    const data = await fs.readFile(file);
    const stat = await fs.stat(file);
    const contentHash = hashContent(data);
    games.push({
      gameId: contentHash,
      title: path.basename(entry.name, path.extname(entry.name)),
      core: "dosbox_pure",
      fileName: entry.name,
      contentUrl: `/assets/games/${encodeURIComponent(entry.name)}`,
      contentHash,
      contentSize: stat.size,
      updatedAt: stat.mtime.toISOString()
    });
  }

  games.sort((a, b) => a.fileName.localeCompare(b.fileName));
  sendJson(res, 200, games);
}

async function route(req, res) {
  if (req.method === "OPTIONS")
    return sendJson(res, 200, {});

  const url = new URL(req.url, `http://${req.headers.host}`);
  if (!url.pathname.startsWith("/api/sync/v1/"))
    return sendJson(res, 404, {error: "not found"});

  if (url.pathname === "/api/sync/v1/auth/register")
    return handleRegister(req, res);
  if (url.pathname === "/api/sync/v1/auth/login")
    return handleLogin(req, res);
  if (url.pathname === "/api/sync/v1/auth/logout")
    return handleLogout(req, res);
  if (url.pathname === "/api/sync/v1/auth/me")
    return handleMe(req, res, url);
  if (url.pathname === "/api/sync/v1/manifest")
    return handleManifest(req, res, url);
  if (url.pathname === "/api/sync/v1/games")
    return handleGames(req, res, url);
  if (url.pathname === "/api/sync/v1/file")
  {
    if (req.method === "GET")
      return handleGetFile(req, res, url);
    if (req.method === "PUT")
      return handlePutFile(req, res, url);
    if (req.method === "DELETE")
      return handleDeleteFile(req, res, url);
  }

  sendJson(res, 404, {error: "not found"});
}

const server = http.createServer((req, res) => {
  route(req, res).catch(err => {
    console.error(err);
    sendJson(res, err.statusCode || 500, {error: err.message || String(err)});
  });
});

fs.mkdir(ROOT, {recursive: true}).then(() => {
  server.listen(PORT, () => {
    console.log(`RetroArch cloud_sync-compatible server listening on ${PORT}, root=${ROOT}`);
  });
});
