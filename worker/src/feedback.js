// Обращения с плана: проверка, защита от флуда и создание issue в репозитории.
// Состояния нет: повторы и частоту ограничиваем в памяти экземпляра и, если подключена, привязкой Rate Limiting.
//
// В issue два слоя: читаемый (кто, что, где) и машинный (JSON в HTML-комментарии `cu-feedback`),
// по которому scripts/feedback.py находит этаж и координаты на плане.

import { HttpError } from "./caldav.js";
import { LIMITS, fingerprint, moderateContact, moderateText, quote } from "./moderation.js";

const KINDS = {
  map: { title: "План", label: "map-error", name: "Неточность на плане" },
  bug: { title: "Ошибка", label: "app-bug", name: "Ошибка в приложении" },
  idea: { title: "Идея", label: "idea", name: "Идея или пожелание" },
};
const CAMPUS_NAMES = { CT: "Центральный телеграф", DUCAT: "Дукат" };
const SITE = "https://stakancheck.github.io/cu-schedule/";

const MIN_FILL_MS = 4000;            // быстрее человек не напишет: так отсекаем скрипты
const PER_IP = { count: 3, window: 10 * 60e3 };
const PER_DAY_IP = 8;
const GLOBAL = { count: 60, window: 60 * 60e3 };

const hits = new Map();              // ключ -> метки времени
const seen = new Map();              // отпечаток текста -> время
function allow(key, count, windowMs, now) {
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= count) { hits.set(key, arr); return false; }
  arr.push(now);
  hits.set(key, arr);
  if (hits.size > 5000) for (const k of hits.keys()) { if (!(hits.get(k) || []).some((t) => now - t < 86400e3)) hits.delete(k); }
  return true;
}

const num = (v, lo, hi) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v * 10) / 10 : null);
const str = (v, max) => (typeof v === "string" ? v.normalize("NFKC").replace(/[^\p{L}\p{N} ._:/()+,-]/gu, "").slice(0, max).trim() : "");

/* ------------------------------------------------------------ устройство */

// Систему и браузер берём из заголовка User-Agent (его не подделать из формы), остальное присылает клиент
function parseUa(ua) {
  const u = String(ua || "");
  const os = /iPhone|iPad|iPod/.test(u) ? "iOS " + ((/OS (\d+)[_.]/.exec(u) || [])[1] || "")
    : /Android (\d+)/.test(u) ? "Android " + /Android (\d+)/.exec(u)[1]
    : /Windows NT/.test(u) ? "Windows" : /Mac OS X/.test(u) ? "macOS" : /Linux/.test(u) ? "Linux" : "?";
  const m = /(Edg|YaBrowser|OPR|SamsungBrowser|Firefox|FxiOS|CriOS|Chrome|Version)\/(\d+)/.exec(u);
  const names = { Edg: "Edge", YaBrowser: "Яндекс Браузер", OPR: "Opera", SamsungBrowser: "Samsung Browser", FxiOS: "Firefox", CriOS: "Chrome", Version: "Safari" };
  const browser = m ? `${names[m[1]] || m[1]} ${m[2]}` : /Telegram/i.test(u) ? "Telegram" : "?";
  return { os: os.trim(), browser };
}

function device(b, ua) {
  const e = b && typeof b === "object" ? b : {};
  const pair = (v) => (Array.isArray(v) && v.length === 2 && v.every((n) => Number.isFinite(n) && n > 0 && n < 20000) ? v.map(Math.round) : null);
  const tg = e.tg && typeof e.tg === "object" ? { platform: str(e.tg.platform, 20), version: str(e.tg.version, 10) } : null;
  return {
    ...parseUa(ua),
    app: str(e.app, 40),
    screen: pair(e.screen), viewport: pair(e.viewport), dpr: num(e.dpr, 0.5, 8),
    lang: str(e.lang, 12), theme: ["light", "dark"].includes(e.theme) ? e.theme : "",
    touch: !!e.touch, tg,
  };
}

const deviceLine = (d) => [
  `${d.os}, ${d.browser}`,
  d.viewport && `окно ${d.viewport.join("x")}${d.dpr ? ` @${d.dpr}x` : ""}`,
  d.screen && `экран ${d.screen.join("x")}`,
  d.touch && "касание",
  d.theme && `тема ${d.theme}`,
  d.lang,
  d.tg && `Telegram ${d.tg.platform} ${d.tg.version}`.trim(),
  d.app && `сборка ${d.app}`,
].filter(Boolean).join(" · ");

/* ------------------------------------------------------------ разбор */

export function parseFeedback(b, ua) {
  const kind = KINDS[b.kind] ? b.kind : null;
  if (!kind) throw new HttpError(400, "bad_kind", "Неизвестный тип обращения");
  const t = moderateText(b.text);
  if (!t.ok) throw new HttpError(422, t.code, t.message);
  const c = moderateContact(b.contact);
  if (!c.ok) throw new HttpError(422, c.code, c.message);
  if (b.consent !== true) throw new HttpError(422, "consent", "Нужно согласие на публикацию обращения");

  let pin = null;
  const p = b.pin;
  if (p && typeof p === "object") {
    const campus = typeof p.campus === "string" && CAMPUS_NAMES[p.campus] ? p.campus : null;
    const floor = num(p.floor, -3, 40), x = num(p.x, -50000, 50000), y = num(p.y, -50000, 50000);
    if (!campus || floor == null || x == null || y == null) throw new HttpError(400, "bad_pin", "Отметка на плане задана неверно");
    pin = { campus, floor, x, y, room: str(p.room, 24), near: str(p.near, 60) };
  }
  return { kind, text: t.text, contact: c.text, pin, device: device(b.device, ua), took: Number(b.took) || 0 };
}

/* ------------------------------------------------------------ issue */

export function buildIssue(f, fp) {
  const k = KINDS[f.kind];
  const where = f.pin ? `${CAMPUS_NAMES[f.pin.campus]}, ${f.pin.floor} этаж` : "";
  const brief = f.text.replace(/\s+/g, " ").replace(/[<>`*_[\]#@\\|]/g, "").slice(0, 70).trim();
  const title = `[${k.title}${f.pin ? " " + f.pin.campus + " " + f.pin.floor : ""}] ${brief}${f.text.length > 70 ? "…" : ""}`;

  const meta = {
    v: 1, kind: f.kind, fp,
    pin: f.pin,
    device: f.device,
    contact: !!f.contact,
  };
  // «<» в JSON экранируем, чтобы ничто не закрыло комментарий раньше времени
  const json = JSON.stringify(meta).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/--/g, "-\\u002d");

  const lines = [`**${k.name}**`, ""];
  if (f.pin) {
    const link = `${SITE}#c=${f.pin.campus}&f=${f.pin.floor}&mk=${f.pin.x},${f.pin.y}`;
    lines.push(
      `**Место:** ${where}${f.pin.room ? `, помещение ${f.pin.room}` : f.pin.near ? `, рядом: ${f.pin.near}` : ""}`,
      `**Координаты на плане:** \`${f.pin.x}, ${f.pin.y}\` ([открыть на плане](${link}))`, "",
    );
  } else if (f.kind === "map") lines.push("**Место:** не отмечено", "");
  lines.push(quote(f.text), "");
  lines.push(`**Контакт:** ${f.contact ? "`" + f.contact + "`" : "не указан"}`, "");
  lines.push(`<details><summary>Устройство</summary>\n\n${deviceLine(f.device)}\n\n</details>`, "");
  lines.push(`<!-- cu-feedback ${json} -->`);

  const labels = ["feedback", k.label];
  if (f.pin) labels.push("campus:" + f.pin.campus, "floor:" + f.pin.floor);
  return { title, body: lines.join("\n"), labels };
}

async function createIssue(env, issue) {
  // локальная проверка: GITHUB_TOKEN="dry" ничего не отправляет, а печатает issue
  if (env.GITHUB_TOKEN === "dry") {
    console.log("--- issue (dry run) ---\n" + issue.title + "\n[" + issue.labels.join(", ") + "]\n\n" + issue.body + "\n---");
    return { number: 0, url: "" };
  }
  const repo = env.GITHUB_REPO || "stakancheck/cu-schedule";
  const r = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "cu-schedule-feedback",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(issue),
  });
  if (!r.ok) {
    console.error("github", r.status);
    throw new HttpError(502, "github", "Не удалось отправить. Попробуйте позже или напишите в Telegram");
  }
  const j = await r.json();
  return { number: j.number, url: j.html_url };
}

/* ------------------------------------------------------------ обработчик */

export async function feedback(req, env, json) {
  if (!env.GITHUB_TOKEN) throw new HttpError(503, "disabled", "Приём обращений пока не настроен");
  let b;
  try { b = await req.json(); } catch { throw new HttpError(400, "bad_json", "Ожидался JSON"); }
  if (!b || typeof b !== "object") throw new HttpError(400, "bad_json", "Ожидался JSON");

  // ловушка для ботов: поле скрыто от людей. Отвечаем «успехом», чтобы бот не подбирал обход
  if (b.website) return json({ ok: true, number: 0 });
  if (!(Number(b.took) >= MIN_FILL_MS)) throw new HttpError(429, "too_fast", "Слишком быстро. Проверьте текст и отправьте ещё раз");

  const now = Date.now();
  const ip = req.headers.get("CF-Connecting-IP") || "local";
  if (env.FEEDBACK_RL) {
    const { success } = await env.FEEDBACK_RL.limit({ key: ip });
    if (!success) throw new HttpError(429, "rate", "Слишком часто. Подождите минуту");
  }
  if (!allow("ip:" + ip, PER_IP.count, PER_IP.window, now) || !allow("day:" + ip, PER_DAY_IP, 86400e3, now) || !allow("all", GLOBAL.count, GLOBAL.window, now)) {
    throw new HttpError(429, "rate", "Слишком много обращений. Попробуйте позже");
  }

  const f = parseFeedback(b, req.headers.get("User-Agent"));
  const fp = await fingerprint(f.text + (f.pin ? `${f.pin.campus}${f.pin.floor}` : ""));
  const prev = seen.get(fp);
  if (prev && now - prev < 24 * 3600e3) throw new HttpError(409, "duplicate", "Такое обращение уже отправлено, спасибо");
  seen.set(fp, now);
  if (seen.size > 2000) for (const [k, t] of seen) if (now - t > 24 * 3600e3) seen.delete(k);

  try {
    const r = await createIssue(env, buildIssue(f, fp));
    return json({ ok: true, number: r.number, url: r.url });
  } catch (e) {
    seen.delete(fp);                // не вышло: дать повторить
    throw e;
  }
}

export { KINDS, LIMITS };
