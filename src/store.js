// Общие данные сайта и админки: статистика, игроки, скрипты.
// Ключи в хранилище:
//   stat:YYYY-MM-DD   { keys, verifies, runs }            — счётчики за день (хранятся 90 дней)
//   user:<hwidHash>   { key, name, userId, executor, ... } — кто и чем запускал
//   script:<id>       { id, name, places, isDefault, enabled, code, updated }

const DAY_TTL = 90 * 24 * 3600;

export const today = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

export async function bumpStat(env, field, n = 1) {
  const k = `stat:${today()}`;
  const s = (await env.KEYS.get(k, "json")) || { keys: 0, verifies: 0, runs: 0 };
  s[field] = (s[field] || 0) + n;
  await env.KEYS.put(k, JSON.stringify(s), { expirationTtl: DAY_TTL });
}

export async function statsForDays(env, days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = today(Date.now() - i * 86400000);
    out.push({ day: d, ...((await env.KEYS.get(`stat:${d}`, "json")) || { keys: 0, verifies: 0, runs: 0 }) });
  }
  return out;
}

const clip = (v, n) => String(v ?? "").slice(0, n);

// Данные, которые loader присылает о себе (executor, игрок, место)
export function clientInfo(url) {
  const p = url.searchParams;
  return {
    executor: clip(p.get("executor"), 60),
    executorVersion: clip(p.get("exver"), 40),
    name: clip(p.get("user"), 40),
    userId: /^\d{1,20}$/.test(p.get("uid") || "") ? p.get("uid") : "",
    placeId: /^\d{1,20}$/.test(p.get("place") || "") ? p.get("place") : "",
  };
}

export async function recordUser(env, hwidHash, key, info, event) {
  const k = `user:${hwidHash}`;
  const now = Date.now();
  const u = (await env.KEYS.get(k, "json")) || { hwid: hwidHash, firstSeen: now, runs: 0, verifies: 0 };
  Object.assign(u, { key, lastSeen: now });
  for (const f of ["executor", "executorVersion", "name", "userId", "placeId", "scriptId"]) {
    if (info[f]) u[f] = info[f];
  }
  if (event === "run") u.runs += 1;
  else u.verifies += 1;
  await env.KEYS.put(k, JSON.stringify(u));
}

// ---------- scripts ----------

export async function listScripts(env) {
  const rows = await env.KEYS.list("script:");
  return rows.map((r) => JSON.parse(r.value)).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getScript(env, id) {
  return env.KEYS.get(`script:${id}`, "json");
}

export async function saveScript(env, s) {
  if (s.isDefault) {
    for (const other of await listScripts(env)) {
      if (other.id !== s.id && other.isDefault) {
        other.isDefault = false;
        await env.KEYS.put(`script:${other.id}`, JSON.stringify(other));
      }
    }
  }
  await env.KEYS.put(`script:${s.id}`, JSON.stringify(s));
}

export async function deleteScript(env, id) {
  await env.KEYS.delete(`script:${id}`);
}

// Loader с ключ-системой для конкретного скрипта (шаблон loader/loader.lua)
export function publicUrl(env) {
  return String(env.PUBLIC_URL || `http://127.0.0.1:${env.PORT || 8787}`).replace(/\/+$/, "");
}

export function buildLoader(env, id, nonce = "") {
  const tpl = typeof env.loaderTemplate === "function" ? env.loaderTemplate() : "";
  const out = tpl
    .replaceAll("{{SITE}}", publicUrl(env))
    .replaceAll("{{SCRIPT_ID}}", id)
    .replaceAll("{{NONCE}}", nonce);
  if (env.LOADER_MINIFY === "0") return out;
  // убираем комментарии и пустые строки — меньше подсказок тому, кто откроет loader
  return out
    .split("\n")
    .map((l) => l.replace(/^\s*--(?!\[).*/, "").trimEnd())
    .filter((l) => l.trim() !== "")
    .join("\n")
    .trim();
}

export const loaderOneLiner = (env, id) => `loadstring(game:HttpGet("${publicUrl(env)}/l/${id}"))()`;

// Какой скрипт отдать: привязанный к PlaceId -> скрипт по умолчанию -> файл SCRIPT_FILE
export async function resolveScript(env, placeId) {
  const scripts = (await listScripts(env)).filter((s) => s.enabled);
  const byPlace = placeId && scripts.find((s) => s.places.includes(String(placeId)));
  const chosen = byPlace || scripts.find((s) => s.isDefault);
  if (chosen) return chosen.code;
  return env.KEYS.get("script"); // файл script/SrannyHub.lua
}
