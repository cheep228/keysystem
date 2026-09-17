// SrannyHub key system — запуск на VPS (Node.js 20+).
// Логика сайта та же, что в src/index.js; здесь только HTTP-сервер и хранилище на диске.
//
//   node server/server.mjs          (настройки из .env рядом с package.json)

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../src/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------- .env ----------
function loadEnv(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}
const config = { ...loadEnv(path.join(ROOT, ".env")), ...process.env };

const PORT = Number(config.PORT || 8787);
const HOST = config.HOST || "127.0.0.1"; // наружу смотрит Caddy, сам сервер только на localhost
const DATA_DIR = path.resolve(ROOT, config.DATA_DIR || "data");
const SCRIPT_FILE = path.resolve(ROOT, config.SCRIPT_FILE || "script/SrannyHub.lua");

// ---------- KV на диске (замена Cloudflare KV) ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const KV_FILE = path.join(DATA_DIR, "kv.json");
const store = new Map(fs.existsSync(KV_FILE) ? Object.entries(JSON.parse(fs.readFileSync(KV_FILE, "utf8"))) : []);

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = KV_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(store)));
    fs.renameSync(tmp, KV_FILE);
  }, 200);
}

function alive(entry) {
  return entry && (!entry.exp || entry.exp > Date.now());
}

const KEYS = {
  async get(key, type) {
    // код хаба читается прямо из файла — обновил файл, и сразу раздаётся новая версия
    if (key === "script") return fs.existsSync(SCRIPT_FILE) ? fs.readFileSync(SCRIPT_FILE, "utf8") : null;
    const entry = store.get(key);
    if (!alive(entry)) {
      if (entry) { store.delete(key); scheduleSave(); }
      return null;
    }
    return type === "json" ? JSON.parse(entry.v) : entry.v;
  },
  async put(key, value, opts = {}) {
    store.set(key, { v: String(value), exp: opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : 0 });
    scheduleSave();
  },
  async delete(key) {
    store.delete(key);
    scheduleSave();
  },
};

// чистка истёкших записей раз в 10 минут
setInterval(() => {
  let changed = false;
  for (const [k, e] of store) if (!alive(e)) { store.delete(k); changed = true; }
  if (changed) scheduleSave();
}, 10 * 60 * 1000).unref();

const env = { ...config, KEYS };

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  try {
    const proto = req.headers["x-forwarded-proto"] || "http";
    const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`;
    const url = `${proto}://${host}${req.url}`;

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
      else if (v != null) headers.set(k, v);
    }
    // реальный IP клиента от Caddy
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    headers.set("cf-connecting-ip", ip);

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks);

    const response = await worker.fetch(new Request(url, { method: req.method, headers, body, redirect: "manual" }), env);

    const outHeaders = {};
    response.headers.forEach((v, k) => { outHeaders[k] = v; });
    res.writeHead(response.status, outHeaders);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    console.error(err);
    res.writeHead(500, { "content-type": "application/json" });
    res.end('{"ok":false,"error":"internal"}');
  }
});

server.listen(PORT, HOST, () => console.log(`SrannyHub keys on http://${HOST}:${PORT}`));

function shutdown() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    fs.writeFileSync(KV_FILE, JSON.stringify(Object.fromEntries(store)));
  }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
