// API личного расписания: вход, события из Яндекс Календаря, отметка присутствия.
// Cloudflare Worker без состояния: данные для входа живут в зашифрованной сессии у клиента.
//
//   POST /v1/session   { provider: "caldav", login, password } -> { token, user }
//   GET  /v1/me        -> { user }
//   GET  /v1/events    ?from=YYYY-MM-DD&to=YYYY-MM-DD[&since=<ctag>] -> { ctag, events } | { unchanged }
//   POST /v1/rsvp      { href, uid, recurrenceId, scope: "one"|"series", partstat } -> { ok }

import { CalDav, HttpError } from "./caldav.js";
import { parse, serialize, expand, setPartstat, wallToUtc, DEFAULT_TZ, PARTSTATS } from "./ical.js";
import { toAppEvent } from "./timetable.js";
import { seal, unseal } from "./session.js";
import { provider, providers } from "./providers.js";

const DAY = 86400000;
const MAX_RANGE_DAYS = 200;

function corsHeaders(req, env) {
  const origin = req.headers.get("Origin");
  if (!origin) return {};
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (!allowed.includes(origin) && !local) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
});

async function body(req) {
  try { return await req.json(); } catch (e) { throw new HttpError(400, "bad_json", "Ожидался JSON"); }
}

async function session(req, env) {
  const m = /^Bearer\s+(\S+)$/.exec(req.headers.get("Authorization") || "");
  if (!m) throw new HttpError(401, "session", "Нужно войти");
  const s = await unseal(m[1], env.SESSION_KEY);
  const p = provider(s.p);
  return { ...s, dav: new CalDav(p.authorization(s.c), env.CALDAV_BASE) };
}

const publicUser = (s) => ({ email: s.emails[0], emails: s.emails, name: s.name || "", provider: s.p });

function day(str, name) {
  const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(str || "");
  if (!m) throw new HttpError(400, "bad_range", `Параметр ${name}: нужна дата YYYY-MM-DD`);
  return wallToUtc(Date.UTC(+m[1], +m[2] - 1, +m[3]), DEFAULT_TZ);
}

/* ------------------------------------------------------------ обработчики */

async function login(req, env) {
  const b = await body(req);
  const p = provider(b.provider || "caldav");
  const creds = await p.login(b, env);
  const dav = new CalDav(p.authorization(creds), env.CALDAV_BASE);
  const who = await dav.discover();
  // адрес из логина первым: по нему ищем себя среди участников
  const emails = [...new Set([...p.emails(creds), ...who.emails])];
  const s = { p: b.provider || "caldav", c: creds, home: who.home, emails, name: who.name };
  return json({ token: await seal(s, env.SESSION_KEY), user: publicUser(s) });
}

async function events(req, env, url) {
  const s = await session(req, env);
  const fromUtc = day(url.searchParams.get("from"), "from");
  const toUtc = day(url.searchParams.get("to"), "to") + DAY;
  if (toUtc <= fromUtc || toUtc - fromUtc > MAX_RANGE_DAYS * DAY) throw new HttpError(400, "bad_range", `Интервал до ${MAX_RANGE_DAYS} дней`);

  const cals = await s.dav.calendars(s.home);
  const ctag = cals.length && cals.every((c) => c.ctag) ? cals.map((c) => c.ctag).join("|") : "";
  const since = url.searchParams.get("since");
  if (ctag && since === ctag) return json({ unchanged: true, ctag });

  const lists = await Promise.all(cals.map(async (cal) => {
    const objs = await s.dav.objects(cal.href, fromUtc, toUtc);
    const out = [];
    for (const o of objs) {
      for (const inst of expand(parse(o.ics), fromUtc, toUtc)) {
        out.push({ ...toAppEvent(inst, { href: o.href, emails: s.emails }), calendar: cal.name });
      }
    }
    return out;
  }));
  const all = lists.flat().sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
  return json({ ctag, user: publicUser(s), events: all, fetchedAt: new Date().toISOString() });
}

async function rsvp(req, env) {
  const s = await session(req, env);
  const b = await body(req);
  if (!PARTSTATS.includes(b.partstat)) throw new HttpError(400, "bad_partstat", "Неизвестный статус");
  if (typeof b.href !== "string" || !b.href.startsWith(s.home) || /(^|\/)(\.|%2e){1,2}(\/|$)/i.test(b.href)) {
    throw new HttpError(400, "bad_href", "Событие не из вашего календаря");
  }
  if (typeof b.uid !== "string" || !b.uid) throw new HttpError(400, "bad_uid", "Нет UID события");
  const recurrenceId = b.recurrenceId == null ? null : Number(b.recurrenceId);
  const scope = b.scope === "series" ? "series" : "one";

  // Читаем свежую версию и пишем с If-Match: если событие успело поменяться,
  // перечитываем и повторяем, чтобы не затереть чужую правку
  for (let attempt = 0; attempt < 3; attempt++) {
    const { ics, etag } = await s.dav.get(b.href);
    const cal = parse(ics);
    const n = setPartstat(cal, { uid: b.uid, recurrenceId, scope, emails: s.emails, partstat: b.partstat });
    if (!n) throw new HttpError(422, "not_attendee", "Вы не участник этого события");
    if (await s.dav.put(b.href, serialize(cal), etag)) return json({ ok: true, partstat: b.partstat, scope });
  }
  throw new HttpError(409, "conflict", "Событие постоянно меняется, попробуйте позже");
}

/* ------------------------------------------------------------ маршруты */

const routes = {
  "GET /v1/health": async () => json({ ok: true, providers: Object.keys(providers) }),
  "POST /v1/session": login,
  "GET /v1/me": async (req, env) => json({ user: publicUser(await session(req, env)) }),
  "GET /v1/events": events,
  "POST /v1/rsvp": rsvp,
};

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    let res;
    try {
      const handler = routes[`${req.method} ${url.pathname}`];
      res = handler ? await handler(req, env, url) : json({ error: "not_found", message: "Нет такого адреса" }, 404);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      // логируем только код ошибки: ни тел запросов, ни паролей в логах быть не должно
      if (!(e instanceof HttpError)) console.error("internal", e && e.name, e && e.message);
      res = json({ error: e.code || "internal", message: e instanceof HttpError ? e.message : "Внутренняя ошибка" }, status);
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },
};
