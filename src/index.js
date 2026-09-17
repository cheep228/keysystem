// SrannyHub key system — Cloudflare Worker
//
// Поток:
//   GET  /                 главная с кнопкой "Получить ключ"
//   GET  /start            создаёт сессию и отправляет на Linkvertise (dynamic link)
//   GET  /claim?s=&hash=   возврат с Linkvertise: проверка anti-bypass -> выдача ключа
//   GET  /api/verify?key=&hwid=   проверка ключа из скрипта (привязка к HWID при первом входе)
//   GET  /api/script?key=&hwid=   отдаёт код хаба только по валидному ключу
//   POST /api/admin/*      управление ключами (Authorization: Bearer ADMIN_TOKEN)

const SESSION_TTL = 30 * 60;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/": return home(env);
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
  },
};

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

function newKey() {
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
<title>${hub} — ${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
<style>
  :root { --bg:#0b0b10; --card:#15151d; --line:#262633; --text:#ececf3; --muted:#8b8ba0; --accent:#7c5cff; --accent2:#b06bff; --ok:#3ddc84; --bad:#ff5c7a; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:16px;
    background:radial-gradient(900px 500px at 50% -10%, #2a1d5c55, transparent), var(--bg);
    color:var(--text); font-family:Inter,system-ui,sans-serif; }
  .card { width:100%; max-width:440px; background:var(--card); border:1px solid var(--line);
    border-radius:18px; padding:32px 28px; text-align:center; box-shadow:0 20px 60px #0008; }
  .logo { font-weight:800; font-size:30px; letter-spacing:-.5px; margin:0 0 4px;
    background:linear-gradient(90deg,var(--accent),var(--accent2)); -webkit-background-clip:text; background-clip:text; color:transparent; }
  h2 { margin:18px 0 8px; font-size:18px; }
  .muted { color:var(--muted); font-size:14px; line-height:1.5; margin:8px 0 20px; }
  .btn { display:inline-block; width:100%; padding:14px 18px; border:0; border-radius:12px; cursor:pointer;
    background:linear-gradient(90deg,var(--accent),var(--accent2)); color:#fff; font:600 15px Inter,sans-serif; text-decoration:none; }
  .btn:hover { filter:brightness(1.1); }
  .btn.ghost { background:transparent; border:1px solid var(--line); color:var(--text); margin-top:10px; }
  .key { font-family:"JetBrains Mono",monospace; font-size:15px; background:#0e0e14; border:1px dashed var(--accent);
    border-radius:10px; padding:14px; margin:10px 0 14px; word-break:break-all; user-select:all; }
  .steps { text-align:left; color:var(--muted); font-size:14px; padding-left:20px; margin:0 0 22px; }
  .steps li { margin:6px 0; }
  .ok { color:var(--ok); } .bad { color:var(--bad); }
  footer { margin-top:18px; font-size:12px; color:var(--muted); }
  footer a { color:var(--muted); }
</style>
</head>
<body>
<main class="card">
  <p class="logo">${hub}</p>
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
  }

  const left = Math.max(0, Math.round((data.expires - Date.now()) / 3600000));
  return page(env, "Твой ключ", `
    <h2 class="ok">Ключ получен</h2>
    <div class="key" id="k">${esc(key)}</div>
    <button class="btn" onclick="navigator.clipboard.writeText(document.getElementById('k').textContent).then(()=>{this.textContent='Скопировано ✓'})">Копировать</button>
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
  return { valid: true, type: data.type, expires: data.expires || null };
}

async function verify(env, url) {
  const r = await checkKey(env, url.searchParams.get("key"), url.searchParams.get("hwid"));
  return json(r, r.valid ? 200 : 403);
}

async function script(env, url) {
  const r = await checkKey(env, url.searchParams.get("key"), url.searchParams.get("hwid"));
  if (!r.valid) return new Response(`error("[key] ${r.reason}")`, { status: 403, headers: { "content-type": "text/plain" } });
  const code = await env.KEYS.get("script");
  if (!code) return new Response(`error("[key] script not uploaded")`, { status: 503, headers: { "content-type": "text/plain" } });
  return new Response(code, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
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
