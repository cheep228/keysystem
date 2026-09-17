// SrannyHub key system — логика сайта (запуск: server/server.mjs)
//
// Поток:
//   GET  /                 главная с кнопкой "Получить ключ"
//   GET  /start            создаёт сессию и отправляет на Linkvertise (dynamic link)
//   GET  /claim?s=&hash=   возврат с Linkvertise: проверка anti-bypass -> выдача ключа
//   GET  /api/verify?key=&hwid=   проверка ключа из скрипта (привязка к HWID при первом входе)
//   GET  /api/script?key=&hwid=   отдаёт код хаба только по валидному ключу
//   POST /api/admin/*      управление ключами (Authorization: Bearer ADMIN_TOKEN)

import { bumpStat, clientInfo, recordUser, resolveScript, getScript, buildLoader } from "./store.js";

const SESSION_TTL = 30 * 60;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const res = await route(request, env, url);
    // сайт не индексируется поисковиками и не встраивается на чужие страницы
    const out = new Response(res.body, res);
    out.headers.set("x-robots-tag", "noindex, nofollow, noarchive");
    out.headers.set("x-frame-options", "DENY");
    out.headers.set("referrer-policy", "no-referrer");
    return out;
  },
};

async function route(request, env, url) {
    try {
      // /l/<id> — loader с ключ-системой для скрипта <id>
      const lm = url.pathname.match(/^\/l\/([a-f0-9]{12})$/);
      if (lm) return loader(env, lm[1]);
      switch (url.pathname) {
        case "/": return home(env);
        case "/robots.txt": return new Response("User-agent: *\nDisallow: /\n", { headers: { "content-type": "text/plain" } });
        case "/start": return start(request, env, url);
        case "/claim": return claim(request, env, url);
        case "/api/verify": return verify(env, url);
        case "/api/script": return script(env, url);
        case "/api/admin/create": return admin(request, env, adminCreate);
        case "/api/admin/revoke": return admin(request, env, adminRevoke);
        case "/api/admin/reset-hwid": return admin(request, env, adminResetHwid);
        case "/api/admin/info": return admin(request, env, adminInfo);
        default: return page(env, "404", `<p class="muted">Страница не найдена.</p><a class="btn" href="/">На главную</a>`, 404);
      }
    } catch (err) {
      console.error(err);
      return json({ ok: false, error: "internal" }, 500);
    }
}

// ---------- helpers ----------

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newKey() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  const chars = [...a].map((b) => alphabet[b % alphabet.length]).join("");
  return `SRANNY-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}-${chars.slice(12, 16)}`;
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const clientIp = (request) => request.headers.get("cf-connecting-ip") || "0.0.0.0";

function base64Utf8(str) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(str)));
}

// Linkvertise dynamic link: https://link-to.net/<USER_ID>/<rand>/dynamic?r=<base64(target)>
function linkvertiseUrl(env, target) {
  const rand = Math.floor(Math.random() * 1000);
  return `https://link-to.net/${env.LV_USER_ID}/${rand}/dynamic?r=${encodeURIComponent(base64Utf8(target))}`;
}

// Linkvertise Anti-Bypassing: POST .../anti_bypassing?token=&hash= -> TRUE / FALSE
async function linkvertiseHashValid(env, hash) {
  if (env.DEV_NO_LINKVERTISE === "1") return true;
  if (!env.LV_ANTI_BYPASS) return true; // не настроено — полагаемся на сессию и MIN_SECONDS
  if (!hash) return false;
  const res = await fetch(
    `https://publisher.linkvertise.com/api/v1/anti_bypassing?token=${encodeURIComponent(env.LV_ANTI_BYPASS)}&hash=${encodeURIComponent(hash)}`,
    { method: "POST" }
  );
  const text = (await res.text()).trim().toLowerCase();
  return text === "true" || text === '"true"';
}

// ---------- pages ----------

function page(env, title, body, status = 200) {
  const hub = esc(env.HUB_NAME || "SrannyHub");
  const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${hub} — ${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root { --bg:#000; --fg:#fff; --dim:#8a8a8a; --line:#2a2a2a; }
  * { box-sizing:border-box; }
  html, body { background:var(--bg); }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px 16px;
    color:var(--fg); font:400 14px/1.6 "IBM Plex Mono",ui-monospace,monospace; }
  .card { width:100%; max-width:420px; border:1px solid var(--line); padding:28px 24px; }
  .logo { margin:0; font:700 26px/1 "Space Grotesk",sans-serif; letter-spacing:-.02em; text-transform:uppercase; }
  .tag { display:block; margin:8px 0 26px; color:var(--dim); font-size:12px; text-transform:uppercase; letter-spacing:.12em; }
  h2 { margin:0 0 14px; font:500 13px "IBM Plex Mono",monospace; text-transform:uppercase; letter-spacing:.12em; }
  .muted { color:var(--dim); font-size:13px; margin:16px 0 0; }
  .btn { display:block; width:100%; padding:13px 16px; border:1px solid var(--fg); border-radius:0; cursor:pointer;
    background:var(--fg); color:var(--bg); font:500 14px "IBM Plex Mono",monospace; text-align:center;
    text-transform:uppercase; letter-spacing:.08em; text-decoration:none; }
  .btn:hover { background:var(--bg); color:var(--fg); }
  .btn:focus-visible { outline:1px solid var(--fg); outline-offset:3px; }
  .key { font:500 15px "IBM Plex Mono",monospace; border:1px solid var(--fg); padding:14px; margin:0 0 12px;
    word-break:break-all; user-select:all; text-align:center; letter-spacing:.04em; }
  .steps { list-style:none; counter-reset:s; padding:0; margin:0 0 22px; border-top:1px solid var(--line); }
  .steps li { counter-increment:s; display:flex; gap:14px; padding:10px 0; border-bottom:1px solid var(--line); }
  .steps li::before { content:"0" counter(s); color:var(--dim); }
  .ok, .bad { color:var(--fg); }
  footer { margin-top:22px; font-size:12px; color:var(--dim); }
  footer:empty { display:none; }
  footer a { color:var(--dim); }
</style>
</head>
<body>
<main class="card">
  <p class="logo">${hub}</p>
  <span class="tag">Key system</span>
  ${body}
  <footer>${env.COMMUNITY_URL ? `<a href="${esc(env.COMMUNITY_URL)}" target="_blank" rel="noopener">Community</a>` : ""}</footer>
</main>
</body>
</html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function home(env) {
  const hours = Number(env.KEY_HOURS || 24);
  return page(env, "Key", `
    <h2>Получить ключ</h2>
    <ol class="steps">
      <li>Нажми «Получить ключ»</li>
      <li>Пройди Linkvertise до конца</li>
      <li>Скопируй ключ и вставь его в скрипт</li>
    </ol>
    <a class="btn" href="/start">Получить ключ</a>
    <p class="muted">Ключ действует ${hours} ч и привязывается к одному устройству.</p>`);
}

async function start(request, env, url) {
  const session = randomHex(16);
  await env.KEYS.put(
    `sess:${session}`,
    JSON.stringify({ created: Date.now(), ip: await sha256(clientIp(request)) }),
    { expirationTtl: SESSION_TTL }
  );
  const target = `${url.origin}/claim?s=${session}`;
  // DEV_NO_LINKVERTISE=1 — только для локальной проверки: сразу на /claim, без Linkvertise
  if (env.DEV_NO_LINKVERTISE === "1") return Response.redirect(target, 302);
  return Response.redirect(linkvertiseUrl(env, target), 302);
}

async function claim(request, env, url) {
  const s = url.searchParams.get("s") || "";
  const hash = url.searchParams.get("hash") || "";
  const raw = s && (await env.KEYS.get(`sess:${s}`));
  const fail = (msg) =>
    page(env, "Ошибка", `<h2 class="bad">Не получилось</h2><p class="muted">${esc(msg)}</p><a class="btn" href="/">Попробовать снова</a>`, 403);

  if (!raw) return fail("Сессия не найдена или истекла. Начни заново с главной страницы.");
  const sess = JSON.parse(raw);
  const ipHash = await sha256(clientIp(request));

  if (sess.ip !== ipHash) return fail("Сессия начата с другого устройства.");
  if (Date.now() - sess.created < Number(env.MIN_SECONDS || 10) * 1000) return fail("Слишком быстро — похоже на обход Linkvertise.");
  if (!(await linkvertiseHashValid(env, hash))) return fail("Linkvertise не подтвердил прохождение.");

  await env.KEYS.delete(`sess:${s}`);

  // один активный ключ на IP: повторное прохождение отдаёт тот же ключ
  let key = await env.KEYS.get(`ip:${ipHash}`);
  let data = key && (await env.KEYS.get(`key:${key}`, "json"));
  if (!data) {
    const hours = Number(env.KEY_HOURS || 24);
    const ttl = hours * 3600;
    key = newKey();
    data = { type: "free", created: Date.now(), expires: Date.now() + ttl * 1000, hwid: null };
    await env.KEYS.put(`key:${key}`, JSON.stringify(data), { expirationTtl: ttl });
    await env.KEYS.put(`ip:${ipHash}`, key, { expirationTtl: ttl });
    await bumpStat(env, "keys");
  }

  const left = Math.max(0, Math.round((data.expires - Date.now()) / 3600000));
  return page(env, "Твой ключ", `
    <h2 class="ok">Ключ получен</h2>
    <div class="key" id="k">${esc(key)}</div>
    <button class="btn" onclick="navigator.clipboard.writeText(document.getElementById('k').textContent).then(()=>{this.textContent='Скопировано'})">Копировать</button>
    <p class="muted">Осталось ~${left} ч. Ключ привяжется к устройству при первом запуске.</p>`);
}

// ---------- API for the script ----------

async function checkKey(env, key, hwid) {
  key = (key || "").trim().toUpperCase();
  hwid = (hwid || "").trim();
  if (!key) return { valid: false, reason: "no_key" };
  if (!hwid) return { valid: false, reason: "no_hwid" };

  const data = await env.KEYS.get(`key:${key}`, "json");
  if (!data) return { valid: false, reason: "invalid_or_expired" };
  if (data.revoked) return { valid: false, reason: "revoked" };
  if (data.expires && Date.now() > data.expires) return { valid: false, reason: "expired" };

  const hwidHash = await sha256(hwid);
  if (!data.hwid) {
    data.hwid = hwidHash;
    const opts = data.expires ? { expirationTtl: Math.max(60, Math.ceil((data.expires - Date.now()) / 1000)) } : {};
    await env.KEYS.put(`key:${key}`, JSON.stringify(data), opts);
  } else if (data.hwid !== hwidHash) {
    return { valid: false, reason: "hwid_mismatch" };
  }
  return { valid: true, type: data.type, expires: data.expires || null, key, hwidHash };
}

async function verify(env, url) {
  const r = await checkKey(env, url.searchParams.get("key"), url.searchParams.get("hwid"));
  if (!r.valid) return json(r, 403);
  await recordUser(env, r.hwidHash, r.key, clientInfo(url), "verify");
  await bumpStat(env, "verifies");
  return json({ valid: true, type: r.type, expires: r.expires });
}

async function script(env, url) {
  const r = await checkKey(env, url.searchParams.get("key"), url.searchParams.get("hwid"));
  if (!r.valid) return new Response(`error("[key] ${r.reason}")`, { status: 403, headers: { "content-type": "text/plain" } });
  const info = clientInfo(url);
  const id = url.searchParams.get("id") || "";
  let code;
  if (id) {
    const nonce = url.searchParams.get("n") || "";
    const forId = nonce && (await env.KEYS.get(`nonce:${nonce}`));
    if (forId !== id) return new Response(`error("[key] stale loader — запусти loader заново")`, { status: 403, headers: { "content-type": "text/plain" } });
    await env.KEYS.delete(`nonce:${nonce}`);
    const s = await getScript(env, id);
    if (!s || !s.enabled) return new Response(`error("[key] script disabled or removed")`, { status: 404, headers: { "content-type": "text/plain" } });
    code = s.code;
    info.scriptId = id;
  } else {
    code = await resolveScript(env, info.placeId);
  }
  if (!code) return new Response(`error("[key] script not uploaded")`, { status: 503, headers: { "content-type": "text/plain" } });
  await recordUser(env, r.hwidHash, r.key, info, "run");
  await bumpStat(env, "runs");
  return new Response(code, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

async function loader(env, id) {
  const s = await getScript(env, id);
  if (!s || !s.enabled) return new Response(`error("script disabled or removed")`, { status: 404, headers: { "content-type": "text/plain" } });
  // одноразовый токен: код скрипта отдаётся только по свежему loader, а не по голой ссылке
  const nonce = randomHex(8);
  await env.KEYS.put(`nonce:${nonce}`, id, { expirationTtl: 120 });
  return new Response(buildLoader(env, id, nonce), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

// ---------- admin ----------

async function admin(request, env, handler) {
  if (request.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const auth = request.headers.get("authorization") || "";
  if (!env.ADMIN_TOKEN || auth !== `Bearer ${env.ADMIN_TOKEN}`) return json({ ok: false, error: "unauthorized" }, 401);
  const body = await request.json().catch(() => ({}));
  return handler(env, body);
}

// { "hours": 720 } или { "hours": 0 } для вечного; "note" необязательно
async function adminCreate(env, body) {
  const hours = Number(body.hours || 0);
  const key = newKey();
  const data = { type: hours ? "timed" : "lifetime", created: Date.now(), expires: hours ? Date.now() + hours * 3600000 : null, hwid: null, note: body.note || "" };
  await env.KEYS.put(`key:${key}`, JSON.stringify(data), hours ? { expirationTtl: hours * 3600 } : {});
  return json({ ok: true, key, ...data });
}

async function adminRevoke(env, body) {
  const key = String(body.key || "").toUpperCase();
  const data = await env.KEYS.get(`key:${key}`, "json");
  if (!data) return json({ ok: false, error: "not_found" }, 404);
  data.revoked = true;
  await env.KEYS.put(`key:${key}`, JSON.stringify(data));
  return json({ ok: true });
}

async function adminResetHwid(env, body) {
  const key = String(body.key || "").toUpperCase();
  const data = await env.KEYS.get(`key:${key}`, "json");
  if (!data) return json({ ok: false, error: "not_found" }, 404);
  data.hwid = null;
  const opts = data.expires ? { expirationTtl: Math.max(60, Math.ceil((data.expires - Date.now()) / 1000)) } : {};
  await env.KEYS.put(`key:${key}`, JSON.stringify(data), opts);
  return json({ ok: true });
}

async function adminInfo(env, body) {
  const key = String(body.key || "").toUpperCase();
  const data = await env.KEYS.get(`key:${key}`, "json");
  return data ? json({ ok: true, key, ...data }) : json({ ok: false, error: "not_found" }, 404);
}
