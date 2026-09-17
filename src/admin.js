// SrannyHub — админ-панель. Работает на отдельном порту (см. server/server.mjs).
//
//   <base>/login   вход            <base>          статистика
//   <base>/users   игроки          <base>/keys     ключи
//   <base>/scripts скрипты         <base>/scripts/edit?id=
//
// <base> = "/" + ADMIN_PATH, по умолчанию /d8xuj1idaso/panel/8318

import { newKey } from "./index.js";
import { statsForDays, listScripts, getScript, saveScript, deleteScript, today, buildLoader, loaderOneLiner } from "./store.js";

const SESSION_TTL = 12 * 3600;
const LOGIN_MAX_FAILS = 5;
const LOGIN_BLOCK = 15 * 60;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// сравнение без утечки по времени
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const fmtTime = (t) => (t ? new Date(t).toISOString().replace("T", " ").slice(0, 16) : "—");

function ago(t) {
  if (!t) return "—";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s} с назад`;
  if (s < 3600) return `${Math.round(s / 60)} мин назад`;
  if (s < 86400) return `${Math.round(s / 3600)} ч назад`;
  return `${Math.round(s / 86400)} д назад`;
}

const redirect = (to, headers = {}) => new Response(null, { status: 303, headers: { location: to, ...headers } });
const notFound = () => new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });

// ---------- entry ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const base = "/" + String(env.ADMIN_PATH || "d8xuj1idaso/panel/8318").replace(/^\/+|\/+$/g, "");
    if (url.pathname !== base && !url.pathname.startsWith(base + "/")) return notFound();
    const sub = url.pathname.slice(base.length) || "/";

    const res = await route(request, env, url, base, sub).catch((err) => {
      console.error(err);
      return new Response("Internal error", { status: 500 });
    });
    const out = new Response(res.body, res);
    out.headers.set("x-robots-tag", "noindex, nofollow");
    out.headers.set("x-frame-options", "DENY");
    // same-origin: с no-referrer браузер шлёт "Origin: null" в формах, и проверка ниже отклоняла вход
    out.headers.set("referrer-policy", "same-origin");
    out.headers.set("cache-control", "no-store");
    return out;
  },
};

async function route(request, env, url, base, sub) {
  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";

  // POST только со своей страницы
  if (request.method === "POST") {
    // 127.0.0.1 и localhost — один и тот же сервер, сравниваем порт и схему
    const origin = request.headers.get("origin");
    const norm = (o) => o.replace("//localhost:", "//127.0.0.1:");
    if (origin && origin !== "null" && norm(origin) !== norm(url.origin)) return new Response("Bad origin", { status: 403 });
  }

  if (sub === "/login") {
    if (request.method === "POST") return doLogin(request, env, base, ip);
    return loginPage(env, base);
  }

  const session = await currentSession(request, env);
  if (!session) return redirect(`${base}/login`);

  if (request.method === "POST") {
    const form = await request.formData();
    const ok = form.get("csrf") === session.csrf;
    if (!ok) return new Response("Bad CSRF token", { status: 403 });
    switch (sub) {
      case "/logout": return doLogout(request, env, base);
      case "/keys/create": return keyCreate(env, base, form);
      case "/keys/revoke": return keyUpdate(env, base, form, (d) => { d.revoked = true; });
      case "/keys/unrevoke": return keyUpdate(env, base, form, (d) => { delete d.revoked; });
      case "/keys/reset": return keyUpdate(env, base, form, (d) => { d.hwid = null; });
      case "/keys/delete": return keyDelete(env, base, form);
      case "/scripts/save": return scriptSave(env, base, form);
      case "/scripts/delete": return scriptDelete(env, base, form);
      case "/scripts/toggle": return scriptToggle(env, base, form);
      case "/users/delete": {
        const hwid = String(form.get("hwid") || "");
        if (/^[a-f0-9]{64}$/.test(hwid)) await env.KEYS.delete(`user:${hwid}`);
        return redirect(`${base}/users`);
      }
      default: return notFound();
    }
  }

  switch (sub) {
    case "/": return dashboard(env, base, session, url);
    case "/users": return usersPage(env, base, session, url);
    case "/keys": return keysPage(env, base, session, url);
    case "/scripts": return scriptsPage(env, base, session, url);
    case "/scripts/edit": return scriptEdit(env, base, session, url);
    default: return notFound();
  }
}

// ---------- auth ----------

function cookieValue(request, name) {
  const m = (request.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

async function currentSession(request, env) {
  const id = cookieValue(request, "sh_admin");
  if (!id || !/^[a-f0-9]{64}$/.test(id)) return null;
  return env.KEYS.get(`admin_sess:${id}`, "json");
}

async function doLogin(request, env, base, ip) {
  const ipHash = await sha256(ip);
  const failKey = `admin_fail:${ipHash}`;
  const fails = Number((await env.KEYS.get(failKey)) || 0);
  if (fails >= LOGIN_MAX_FAILS) return loginPage(env, base, "Слишком много попыток. Подожди 15 минут.", 429);

  const form = await request.formData();
  const user = String(form.get("user") || "");
  const pass = String(form.get("pass") || "");

  if (!env.ADMIN_USER || !env.ADMIN_PASSWORD) return loginPage(env, base, "ADMIN_USER / ADMIN_PASSWORD не заданы в .env", 500);

  const okUser = safeEqual(await sha256(user), await sha256(env.ADMIN_USER));
  const okPass = safeEqual(await sha256(pass), await sha256(env.ADMIN_PASSWORD));
  if (!(okUser && okPass)) {
    await env.KEYS.put(failKey, String(fails + 1), { expirationTtl: LOGIN_BLOCK });
    return loginPage(env, base, "Неверный логин или пароль.", 401);
  }

  await env.KEYS.delete(failKey);
  const id = randomHex(32);
  await env.KEYS.put(`admin_sess:${id}`, JSON.stringify({ csrf: randomHex(16), created: Date.now() }), { expirationTtl: SESSION_TTL });
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return redirect(base, { "set-cookie": `sh_admin=${id}; Path=${base}; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL}${secure}` });
}

async function doLogout(request, env, base) {
  const id = cookieValue(request, "sh_admin");
  if (id) await env.KEYS.delete(`admin_sess:${id}`);
  return redirect(`${base}/login`, { "set-cookie": `sh_admin=; Path=${base}; HttpOnly; SameSite=Strict; Max-Age=0` });
}

// ---------- layout ----------

const CSS = `
  :root { --bg:#000; --fg:#fff; --dim:#8a8a8a; --line:#262626; --soft:#0d0d0d; }
  * { box-sizing:border-box; }
  html, body { background:var(--bg); }
  body { margin:0; color:var(--fg); font:400 13px/1.55 "IBM Plex Mono",ui-monospace,monospace; }
  a { color:var(--fg); }
  .wrap { max-width:1180px; margin:0 auto; padding:0 16px 48px; }
  header { display:flex; flex-wrap:wrap; align-items:center; gap:8px 24px; padding:18px 0; border-bottom:1px solid var(--line); margin-bottom:24px; }
  .logo { font:700 18px "Space Grotesk",sans-serif; text-transform:uppercase; letter-spacing:-.01em; text-decoration:none; }
  nav { display:flex; flex-wrap:wrap; gap:4px; flex:1; }
  nav a { padding:6px 10px; text-decoration:none; color:var(--dim); text-transform:uppercase; letter-spacing:.08em; font-size:12px; }
  nav a.on { color:var(--bg); background:var(--fg); }
  h1 { font:500 13px "IBM Plex Mono",monospace; text-transform:uppercase; letter-spacing:.12em; margin:0 0 14px; }
  h1 small { color:var(--dim); letter-spacing:0; text-transform:none; margin-left:8px; }
  section { margin-bottom:32px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:1px; background:var(--line); border:1px solid var(--line); }
  .stat { background:var(--bg); padding:16px; }
  .stat b { display:block; font:700 28px/1.1 "Space Grotesk",sans-serif; }
  .stat span { color:var(--dim); font-size:12px; text-transform:uppercase; letter-spacing:.08em; }
  .chart { display:flex; align-items:flex-end; gap:4px; height:140px; border-bottom:1px solid var(--line); padding-top:8px; }
  .chart div { flex:1; background:var(--fg); min-height:1px; position:relative; }
  .chart div:hover::after { content:attr(data-t); position:absolute; bottom:100%; left:50%; transform:translate(-50%,-6px); white-space:nowrap; background:var(--fg); color:var(--bg); padding:2px 6px; font-size:11px; }
  .axis { display:flex; justify-content:space-between; color:var(--dim); font-size:11px; margin-top:6px; }
  .table { width:100%; overflow-x:auto; border:1px solid var(--line); }
  table { width:100%; border-collapse:collapse; min-width:720px; }
  th, td { text-align:left; padding:9px 12px; border-bottom:1px solid var(--line); vertical-align:top; white-space:nowrap; }
  th { color:var(--dim); font-weight:400; text-transform:uppercase; letter-spacing:.08em; font-size:11px; }
  tr:last-child td { border-bottom:0; }
  .dim { color:var(--dim); }
  .bar { display:flex; align-items:center; gap:10px; }
  .bar i { display:block; height:8px; background:var(--fg); }
  form.inline { display:inline; margin:0; }
  .row { display:flex; flex-wrap:wrap; gap:8px; align-items:end; }
  label { display:flex; flex-direction:column; gap:4px; color:var(--dim); font-size:11px; text-transform:uppercase; letter-spacing:.08em; }
  input, select, textarea { background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:0; padding:9px 10px; font:13px "IBM Plex Mono",monospace; }
  input:focus, select:focus, textarea:focus { outline:none; border-color:var(--fg); }
  textarea { width:100%; min-height:420px; resize:vertical; tab-size:4; line-height:1.45; }
  button, .btn { background:var(--fg); color:var(--bg); border:1px solid var(--fg); border-radius:0; padding:9px 14px; cursor:pointer; font:500 12px "IBM Plex Mono",monospace; text-transform:uppercase; letter-spacing:.08em; text-decoration:none; display:inline-block; }
  button:hover, .btn:hover { background:var(--bg); color:var(--fg); }
  button.ghost, .btn.ghost { background:var(--bg); color:var(--fg); border-color:var(--line); }
  button.ghost:hover, .btn.ghost:hover { border-color:var(--fg); }
  button.small { padding:4px 8px; font-size:11px; }
  .note { border:1px solid var(--fg); padding:10px 12px; margin-bottom:18px; }
  .pill { display:inline-block; border:1px solid var(--line); padding:0 6px; font-size:11px; margin-right:4px; }
  .pill.on { background:var(--fg); color:var(--bg); border-color:var(--fg); }
  .code { display:block; width:100%; background:var(--bg); border:1px solid var(--line); padding:10px 12px; font:12px/1.5 "IBM Plex Mono",monospace; white-space:pre; overflow-x:auto; color:var(--fg); }
  .copyrow { display:flex; gap:8px; align-items:stretch; }
  .copyrow .code { flex:1; }
  .login { min-height:100vh; display:flex; align-items:center; justify-content:center; padding:16px; }
  .login form { width:100%; max-width:340px; border:1px solid var(--line); padding:26px 22px; display:flex; flex-direction:column; gap:12px; }
  .login input, .login button { width:100%; }
`;

function layout(env, base, session, active, title, body, status = 200) {
  const nav = [["", "Статистика"], ["/users", "Игроки"], ["/keys", "Ключи"], ["/scripts", "Скрипты"]]
    .map(([p, t]) => `<a href="${base}${p}" class="${active === p ? "on" : ""}">${t}</a>`)
    .join("");
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>${esc(title)} — ${esc(env.HUB_NAME || "SrannyHub")} admin</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body><div class="wrap">
<header><a class="logo" href="${base}">${esc(env.HUB_NAME || "SrannyHub")} / admin</a><nav>${nav}</nav>
<form class="inline" method="post" action="${base}/logout"><input type="hidden" name="csrf" value="${session.csrf}"><button class="ghost small">Выйти</button></form>
</header>${body}</div>
<script>
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-copy]");
  if (!b) return;
  const el = document.getElementById(b.dataset.copy);
  navigator.clipboard.writeText(el.value ?? el.textContent).then(() => {
    const t = b.textContent; b.textContent = "Скопировано"; setTimeout(() => (b.textContent = t), 1200);
  });
});
</script></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function loginPage(env, base, error = "", status = 200) {
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>Login</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body><div class="login">
<form method="post" action="${base}/login" autocomplete="off">
  <div class="logo">${esc(env.HUB_NAME || "SrannyHub")} / admin</div>
  ${error ? `<div class="note">${esc(error)}</div>` : ""}
  <label>Логин<input name="user" required autofocus></label>
  <label>Пароль<input name="pass" type="password" required></label>
  <button>Войти</button>
</form></div></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

const csrfInput = (session) => `<input type="hidden" name="csrf" value="${session.csrf}">`;
const flash = (url) => (url.searchParams.get("msg") ? `<div class="note">${esc(url.searchParams.get("msg"))}</div>` : "");

// ---------- dashboard ----------

async function dashboard(env, base, session, url) {
  const [days, users, keys, scripts] = await Promise.all([
    statsForDays(env, 30),
    env.KEYS.list("user:"),
    env.KEYS.list("key:"),
    listScripts(env),
  ]);
  const u = users.map((r) => JSON.parse(r.value));
  const k = keys.map((r) => JSON.parse(r.value));
  const now = Date.now();
  const d = today();
  const todayStat = days[days.length - 1];

  const activeKeys = k.filter((x) => !x.revoked && (!x.expires || x.expires > now)).length;
  const online24 = u.filter((x) => now - x.lastSeen < 86400000).length;
  const online1h = u.filter((x) => now - x.lastSeen < 3600000).length;
  const newToday = u.filter((x) => today(x.firstSeen) === d).length;

  const executors = {};
  for (const x of u) executors[x.executor || "unknown"] = (executors[x.executor || "unknown"] || 0) + 1;
  const exRows = Object.entries(executors).sort((a, b) => b[1] - a[1]);
  const exMax = Math.max(1, ...exRows.map((r) => r[1]));

  const places = {};
  for (const x of u) if (x.placeId) places[x.placeId] = (places[x.placeId] || 0) + 1;
  const placeRows = Object.entries(places).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const placeScript = (id) => scripts.find((s) => s.enabled && s.places.includes(id))?.name;

  const maxRuns = Math.max(1, ...days.map((x) => x.runs));
  const chart = days
    .map((x) => `<div style="height:${Math.round((x.runs / maxRuns) * 100)}%" data-t="${x.day}: ${x.runs} запусков, ${x.keys} ключей"></div>`)
    .join("");

  return layout(env, base, session, "", "Статистика", `
<section><div class="grid">
  <div class="stat"><b>${u.length}</b><span>Игроков всего</span></div>
  <div class="stat"><b>${online1h}</b><span>Активны за час</span></div>
  <div class="stat"><b>${online24}</b><span>Активны за 24 ч</span></div>
  <div class="stat"><b>${newToday}</b><span>Новых сегодня</span></div>
  <div class="stat"><b>${todayStat.runs}</b><span>Запусков сегодня</span></div>
  <div class="stat"><b>${todayStat.keys}</b><span>Ключей выдано сегодня</span></div>
  <div class="stat"><b>${activeKeys}</b><span>Активных ключей</span></div>
  <div class="stat"><b>${scripts.filter((s) => s.enabled).length}</b><span>Скриптов включено</span></div>
</div></section>

<section><h1>Запуски за 30 дней <small>наведи на столбец</small></h1>
<div class="chart">${chart}</div><div class="axis"><span>${days[0].day}</span><span>${d}</span></div></section>

<section class="row" style="align-items:start;gap:24px">
  <div style="flex:1;min-width:280px"><h1>Экзекьюторы</h1><div class="table"><table style="min-width:0">
    ${exRows.map(([name, n]) => `<tr><td>${esc(name)}</td><td style="width:60%"><div class="bar"><i style="width:${Math.round((n / exMax) * 100)}%"></i>${n}</div></td></tr>`).join("") || `<tr><td class="dim">Пока нет данных</td></tr>`}
  </table></div></div>
  <div style="flex:1;min-width:280px"><h1>Игры (PlaceId)</h1><div class="table"><table style="min-width:0">
    ${placeRows.map(([id, n]) => `<tr><td><a href="https://www.roblox.com/games/${id}" target="_blank" rel="noopener noreferrer">${id}</a></td><td>${n} игр.</td><td class="dim">${esc(placeScript(id) || "по умолчанию")}</td></tr>`).join("") || `<tr><td class="dim">Пока нет данных</td></tr>`}
  </table></div></div>
</section>`);
}

// ---------- users ----------

async function usersPage(env, base, session, url) {
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const ex = url.searchParams.get("executor") || "";
  let users = (await env.KEYS.list("user:")).map((r) => JSON.parse(r.value));
  const executors = [...new Set(users.map((u) => u.executor || "unknown"))].sort();
  if (ex) users = users.filter((u) => (u.executor || "unknown") === ex);
  if (q) users = users.filter((u) => [u.name, u.userId, u.key, u.placeId, u.executor].some((v) => String(v || "").toLowerCase().includes(q)));
  users.sort((a, b) => b.lastSeen - a.lastSeen);

  const rows = users.map((u) => `<tr>
    <td>${u.userId ? `<a href="https://www.roblox.com/users/${esc(u.userId)}/profile" target="_blank" rel="noopener noreferrer">${esc(u.name || u.userId)}</a>` : esc(u.name || "—")}<div class="dim">${esc(u.userId || "")}</div></td>
    <td>${esc(u.executor || "unknown")}<div class="dim">${esc(u.executorVersion || "")}</div></td>
    <td>${u.placeId ? `<a href="https://www.roblox.com/games/${esc(u.placeId)}" target="_blank" rel="noopener noreferrer">${esc(u.placeId)}</a>` : "—"}</td>
    <td>${esc(u.key || "")}</td>
    <td>${u.runs}</td>
    <td>${ago(u.lastSeen)}<div class="dim">${fmtTime(u.lastSeen)}</div></td>
    <td class="dim">${fmtTime(u.firstSeen)}</td>
    <td class="dim" title="${esc(u.hwid)}">${esc((u.hwid || "").slice(0, 10))}</td>
    <td><form class="inline" method="post" action="${base}/users/delete" onsubmit="return confirm('Удалить запись игрока?')">${csrfInput(session)}<input type="hidden" name="hwid" value="${esc(u.hwid)}"><button class="ghost small">Удалить</button></form></td>
  </tr>`).join("");

  return layout(env, base, session, "/users", "Игроки", `
<section><h1>Игроки <small>${users.length}</small></h1>
<form class="row" method="get" style="margin-bottom:14px">
  <label>Поиск<input name="q" value="${esc(q)}" placeholder="ник, UserId, ключ, PlaceId"></label>
  <label>Экзекьютор<select name="executor"><option value="">Все</option>${executors.map((e) => `<option ${e === ex ? "selected" : ""}>${esc(e)}</option>`).join("")}</select></label>
  <button>Найти</button>${q || ex ? `<a class="btn ghost" href="${base}/users">Сброс</a>` : ""}
</form>
<div class="table"><table>
<tr><th>Игрок</th><th>Экзекьютор</th><th>Игра</th><th>Ключ</th><th>Запусков</th><th>Последний вход</th><th>Первый вход</th><th>HWID</th><th></th></tr>
${rows || `<tr><td colspan="9" class="dim">Никого не найдено</td></tr>`}
</table></div></section>`);
}

// ---------- keys ----------

async function keysPage(env, base, session, url) {
  const q = (url.searchParams.get("q") || "").trim().toUpperCase();
  const now = Date.now();
  let keys = (await env.KEYS.list("key:")).map((r) => ({ key: r.name.slice(4), ...JSON.parse(r.value) }));
  if (q) keys = keys.filter((k) => k.key.includes(q) || String(k.note || "").toUpperCase().includes(q));
  keys.sort((a, b) => b.created - a.created);

  const users = new Map((await env.KEYS.list("user:")).map((r) => { const u = JSON.parse(r.value); return [u.key, u]; }));
  const status = (k) => (k.revoked ? "заблокирован" : k.expires && k.expires < now ? "истёк" : "активен");

  const btn = (action, k, text) =>
    `<form class="inline" method="post" action="${base}/keys/${action}">${csrfInput(session)}<input type="hidden" name="key" value="${esc(k.key)}"><button class="ghost small">${text}</button></form>`;

  const rows = keys.slice(0, 500).map((k) => {
    const u = users.get(k.key);
    return `<tr>
      <td>${esc(k.key)}${k.note ? `<div class="dim">${esc(k.note)}</div>` : ""}</td>
      <td><span class="pill ${status(k) === "активен" ? "on" : ""}">${status(k)}</span><div class="dim">${esc(k.type)}</div></td>
      <td>${k.expires ? fmtTime(k.expires) : "навсегда"}</td>
      <td>${k.hwid ? "привязан" : "<span class='dim'>свободен</span>"}${u ? `<div class="dim">${esc(u.name || "")} · ${esc(u.executor || "")}</div>` : ""}</td>
      <td class="dim">${fmtTime(k.created)}</td>
      <td>${k.revoked ? btn("unrevoke", k, "Разблок.") : btn("revoke", k, "Блок")} ${k.hwid ? btn("reset", k, "Сброс HWID") : ""} ${btn("delete", k, "Удалить")}</td>
    </tr>`;
  }).join("");

  return layout(env, base, session, "/keys", "Ключи", `
${flash(url)}
<section><h1>Создать ключ</h1>
<form class="row" method="post" action="${base}/keys/create">${csrfInput(session)}
  <label>Срок<select name="hours"><option value="24">24 часа</option><option value="168">7 дней</option><option value="720">30 дней</option><option value="0">Навсегда</option></select></label>
  <label>Заметка<input name="note" placeholder="кому выдан"></label>
  <button>Создать</button>
</form></section>
<section><h1>Ключи <small>${keys.length}${keys.length > 500 ? ", показаны 500" : ""}</small></h1>
<form class="row" method="get" style="margin-bottom:14px"><label>Поиск<input name="q" value="${esc(q)}" placeholder="ключ или заметка"></label><button>Найти</button></form>
<div class="table"><table>
<tr><th>Ключ</th><th>Статус</th><th>Истекает</th><th>Устройство</th><th>Создан</th><th></th></tr>
${rows || `<tr><td colspan="6" class="dim">Ключей нет</td></tr>`}
</table></div></section>`);
}

async function keyCreate(env, base, form) {
  const hours = Number(form.get("hours") || 0);
  const key = newKey();
  const data = { type: hours ? "timed" : "lifetime", created: Date.now(), expires: hours ? Date.now() + hours * 3600000 : null, hwid: null, note: String(form.get("note") || "").slice(0, 80) };
  await env.KEYS.put(`key:${key}`, JSON.stringify(data), hours ? { expirationTtl: hours * 3600 } : {});
  return redirect(`${base}/keys?msg=${encodeURIComponent("Создан ключ " + key)}`);
}

async function keyUpdate(env, base, form, change) {
  const key = String(form.get("key") || "").toUpperCase();
  const data = await env.KEYS.get(`key:${key}`, "json");
  if (data) {
    change(data);
    const opts = data.expires ? { expirationTtl: Math.max(60, Math.ceil((data.expires - Date.now()) / 1000)) } : {};
    await env.KEYS.put(`key:${key}`, JSON.stringify(data), opts);
  }
  return redirect(`${base}/keys`);
}

async function keyDelete(env, base, form) {
  await env.KEYS.delete(`key:${String(form.get("key") || "").toUpperCase()}`);
  return redirect(`${base}/keys`);
}

// ---------- scripts ----------

async function scriptsPage(env, base, session, url) {
  const scripts = await listScripts(env);
  const legacy = await env.KEYS.get("script");
  const rows = scripts.map((s) => `<tr>
    <td><a href="${base}/scripts/edit?id=${esc(s.id)}">${esc(s.name)}</a></td>
    <td><code class="dim" id="ol-${esc(s.id)}" style="display:none">${esc(loaderOneLiner(env, s.id))}</code><button class="ghost small" type="button" data-copy="ol-${esc(s.id)}">Копировать loader</button></td>
    <td>${s.isDefault ? `<span class="pill on">по умолчанию</span>` : ""}${s.places.map((p) => `<span class="pill">${esc(p)}</span>`).join("") || (s.isDefault ? "" : "<span class='dim'>не привязан</span>")}</td>
    <td><span class="pill ${s.enabled ? "on" : ""}">${s.enabled ? "вкл" : "выкл"}</span></td>
    <td class="dim">${(s.code.length / 1024).toFixed(1)} КБ</td>
    <td class="dim">${fmtTime(s.updated)}</td>
    <td>
      <form class="inline" method="post" action="${base}/scripts/toggle">${csrfInput(session)}<input type="hidden" name="id" value="${esc(s.id)}"><button class="ghost small">${s.enabled ? "Выключить" : "Включить"}</button></form>
      <a class="btn ghost small" style="padding:4px 8px;font-size:11px" href="${base}/scripts/edit?id=${esc(s.id)}">Изменить</a>
    </td></tr>`).join("");

  return layout(env, base, session, "/scripts", "Скрипты", `
${flash(url)}
<section><h1>Как выбирается скрипт</h1>
<p class="dim" style="margin:0 0 10px">Для каждого скрипта генерируется свой loader: игрок запускает его, вводит ключ, и только после проверки ключа исполняется этот скрипт. Скопируй loader кнопкой в таблице или открой скрипт.</p>
<p class="dim" style="margin:0 0 6px">Общий loader без привязки к скрипту выбирает так: 1. Скрипт, привязанный к PlaceId игры, в которой запущен loader.<br>2. Иначе — скрипт «по умолчанию».<br>3. Иначе — файл <code>script/SrannyHub.lua</code>${legacy ? "" : " (сейчас его нет)"}.</p>
</section>
<section><h1>Скрипты <small>${scripts.length}</small></h1>
<p><a class="btn" href="${base}/scripts/edit">+ Добавить скрипт</a></p>
<div class="table"><table>
<tr><th>Название</th><th>Loader</th><th>Привязка</th><th>Статус</th><th>Размер</th><th>Изменён</th><th></th></tr>
${rows || `<tr><td colspan="7" class="dim">Скриптов нет — сейчас раздаётся файл script/SrannyHub.lua</td></tr>`}
</table></div></section>`);
}

async function scriptEdit(env, base, session, url) {
  const id = url.searchParams.get("id");
  const s = id ? await getScript(env, id) : null;
  if (id && !s) return redirect(`${base}/scripts`);
  const v = s || { id: "", name: "", places: [], isDefault: false, enabled: true, code: "" };

  const loaderBlock = s ? `
<section><h1>Loader с ключ-системой ${s.enabled ? "" : "<small>скрипт выключен — loader не будет работать</small>"}</h1>
<p class="dim" style="margin:0 0 10px">Раздавай игрокам. Loader спросит ключ, проверит его на сайте и только потом выполнит «${esc(s.name)}».</p>
<label style="margin-bottom:6px">Одной строкой</label>
<div class="copyrow" style="margin-bottom:16px"><code class="code" id="oneliner">${esc(loaderOneLiner(env, s.id))}</code><button type="button" data-copy="oneliner">Копировать</button></div>
<label style="margin-bottom:6px">Полный loader</label>
<textarea class="code" id="fullloader" readonly style="min-height:220px">${esc(buildLoader(env, s.id))}</textarea>
<div class="row" style="margin-top:8px"><button type="button" data-copy="fullloader">Копировать</button><a class="btn ghost" download="${esc(s.name.replace(/[^\w\-]+/g, "_") || "loader")}_loader.lua" href="data:text/plain;charset=utf-8,${encodeURIComponent(buildLoader(env, s.id))}">Скачать .lua</a></div>
</section>` : `<div class="note">Loader с ключ-системой появится здесь после сохранения скрипта.</div>`;

  return layout(env, base, session, "/scripts", s ? "Изменить скрипт" : "Новый скрипт", `
${loaderBlock}
<section><h1>${s ? "Изменить скрипт" : "Новый скрипт"}</h1>
<form method="post" action="${base}/scripts/save">${csrfInput(session)}
<input type="hidden" name="id" value="${esc(v.id)}">
<div class="row" style="margin-bottom:12px">
  <label style="flex:1;min-width:200px">Название<input name="name" value="${esc(v.name)}" required placeholder="Mog Game"></label>
  <label style="flex:2;min-width:260px">PlaceId игр (через запятую)<input name="places" value="${esc(v.places.join(", "))}" placeholder="1234567890, 9876543210"></label>
  <label>Статус<select name="enabled"><option value="1" ${v.enabled ? "selected" : ""}>Включён</option><option value="0" ${v.enabled ? "" : "selected"}>Выключен</option></select></label>
  <label>По умолчанию<select name="isDefault"><option value="0">Нет</option><option value="1" ${v.isDefault ? "selected" : ""}>Да</option></select></label>
</div>
<div class="row" style="margin-bottom:8px">
  <label>Загрузить .lua файл<input type="file" accept=".lua,.luau,.txt" id="file"></label>
  <span class="dim">или вставь код ниже</span>
</div>
<textarea name="code" id="code" spellcheck="false" required>${esc(v.code)}</textarea>
<div class="row" style="margin-top:12px"><button>Сохранить</button><a class="btn ghost" href="${base}/scripts">Отмена</a></div>
</form>
${s ? `<form method="post" action="${base}/scripts/delete" style="margin-top:28px" onsubmit="return confirm('Удалить скрипт ${esc(v.name).replace(/'/g, "")}?')">${csrfInput(session)}<input type="hidden" name="id" value="${esc(v.id)}"><button class="ghost">Удалить скрипт</button></form>` : ""}
</section>
<script>
document.getElementById("file").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => { document.getElementById("code").value = r.result; };
  r.readAsText(f);
});
document.getElementById("code").addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  e.preventDefault();
  const t = e.target, s = t.selectionStart;
  t.setRangeText("\\t", s, t.selectionEnd, "end");
});
</script>`);
}

async function scriptSave(env, base, form) {
  const existing = form.get("id") ? await getScript(env, String(form.get("id"))) : null;
  const places = String(form.get("places") || "")
    .split(/[\s,;]+/)
    .filter((p) => /^\d{1,20}$/.test(p));
  const s = {
    id: existing?.id || randomHex(6),
    name: String(form.get("name") || "Без названия").slice(0, 60),
    places: [...new Set(places)],
    isDefault: form.get("isDefault") === "1",
    enabled: form.get("enabled") === "1",
    code: String(form.get("code") || ""),
    updated: Date.now(),
  };
  await saveScript(env, s);
  return redirect(`${base}/scripts/edit?id=${s.id}`);
}

async function scriptDelete(env, base, form) {
  await deleteScript(env, String(form.get("id") || ""));
  return redirect(`${base}/scripts?msg=${encodeURIComponent("Скрипт удалён")}`);
}

async function scriptToggle(env, base, form) {
  const s = await getScript(env, String(form.get("id") || ""));
  if (s) {
    s.enabled = !s.enabled;
    s.updated = Date.now();
    await saveScript(env, s);
  }
  return redirect(`${base}/scripts`);
}
