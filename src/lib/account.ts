// Личное расписание: вход, кэш событий, синхронизация с Яндекс Календарём и отметки.
// Способ входа (пароль приложения сейчас, Яндекс ID потом) виден только в login();
// дальше везде одна и та же сессия, которую выдаёт API.
import { useSyncExternalStore } from "react";

// Адрес API личного расписания (Cloudflare Worker из папки worker/).
// Если адрес пустой, вход и «Мои пары» на сайте не показываются.
// На localhost используется локальный сервер: cd worker && npm run dev
const API = (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)
  ? "http://localhost:8787"
  : "https://cu-schedule-api.cu-schedule-api.workers.dev").replace(/\/$/, "");

const K_SESSION = "cu.session", K_EVENTS = "cu.events";
const PAST_DAYS = 14, AHEAD_DAYS = 120;
const SYNC_EVERY = 5 * 60000, SYNC_ON_FOCUS = 60000;

export type Partstat = "ACCEPTED" | "TENTATIVE" | "DECLINED" | "NEEDS-ACTION";

export interface MyEvent {
  id: string; uid: string; href: string; recurrenceId?: string; recurring?: boolean;
  start: string; end: string; title: string; type?: string; rooms: string[];
  campus?: string; campusName?: string; online?: boolean; url?: string; location?: string;
  calendar?: string; timetable?: boolean; allDay?: boolean; partstat?: Partstat;
  // посчитанное на клиенте
  date: string; startHM: string; endHM: string; s: number; e: number;
}
interface User { email: string; name?: string }
interface Session { token: string; user: User }
interface Cache { from: string; to: string; ctag: string; fetchedAt: string; email: string; events: MyEvent[] }

const store = {
  get<T>(k: string): T | null { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* приватный режим или нет места */ } },
  del(k: string) { try { localStorage.removeItem(k); } catch { /* приватный режим */ } },
};

/* ---------- время по Москве: так же считается общее расписание */
const MSK = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
function msk(isoStr: string) {
  const p: Record<string, string> = {};
  for (const { type, value } of MSK.formatToParts(new Date(isoStr))) p[type] = value;
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, min: +p.hour * 60 + +p.minute };
}
const pad = (n: number) => String(n).padStart(2, "0");
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const shift = (day: string, n: number) => { const [y, m, d] = day.split("-").map(Number); return isoDay(new Date(y, m - 1, d + n)); };

function prepare(ev: MyEvent): MyEvent {
  const a = msk(ev.start), b = msk(ev.end);
  const e = b.date === a.date ? b.min : 24 * 60;
  return { ...ev, date: a.date, startHM: a.hm, endHM: b.date === a.date ? b.hm : "24:00", s: a.min, e: Math.max(e, a.min) };
}

/* ---------- состояние */
const saved = store.get<Session>(K_SESSION);
const S = {
  session: saved && saved.token ? saved : null as Session | null,
  cache: null as Cache | null,
  byDate: new Map<string, MyEvent[]>(),
  syncing: false,
  error: null as string | null,   // текст последней ошибки синхронизации
  pending: new Map<string, Partstat>(), // id события -> отметка, которая ещё сохраняется
};
let version = 0;
const listeners = new Set<(why: string) => void>();
const emit = (why: string) => {
  version++;
  listeners.forEach((fn) => { try { fn(why); } catch (e) { console.error(e); } });
};

function index() {
  S.byDate = new Map();
  if (!S.cache) return;
  for (const ev of S.cache.events) {
    if (!S.byDate.has(ev.date)) S.byDate.set(ev.date, []);
    S.byDate.get(ev.date)!.push(ev);
  }
  for (const list of S.byDate.values()) list.sort((a, b) => a.s - b.s || a.e - b.e || a.title.localeCompare(b.title));
}

function setCache(c: Cache | null) {
  S.cache = c;
  index();
  if (c) store.set(K_EVENTS, c); else store.del(K_EVENTS);
}

if (S.session) {
  const c = store.get<Cache>(K_EVENTS);
  // кэш другого пользователя не показываем
  if (c && c.email === S.session.user.email) { S.cache = c; index(); }
}

/* ---------- запросы */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API + path, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(S.session ? { Authorization: "Bearer " + S.session.token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "network", "Нет связи с сервером");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new ApiError(res.status, data.error || "http", data.message || `Ошибка ${res.status}`);
    // сессия или пароль больше не действуют: выходим, чтобы не показывать старое как актуальное
    if (res.status === 401 && S.session) { logout(); S.error = "Пароль приложения больше не действует. Войдите заново."; emit("logout"); }
    throw err;
  }
  return data;
}

/* ---------- вход и выход */
async function login(provider: string, fields: Record<string, string>) {
  S.session = null;
  const data = await api("POST", "/v1/session", { provider, ...fields });
  S.session = { token: data.token, user: data.user };
  store.set(K_SESSION, S.session);
  S.error = null;
  setCache(null);
  emit("login");
  await sync({ force: true });
  return data.user as User;
}

function logout() {
  S.session = null;
  store.del(K_SESSION);
  setCache(null);
  S.pending.clear();
  emit("logout");
}

/* ---------- синхронизация */
let syncing: Promise<boolean> | null = null;
const rangeFor = (day: string) => ({ from: shift(day, -PAST_DAYS), to: shift(day, AHEAD_DAYS) });

async function sync({ force = false, around }: { force?: boolean; around?: string } = {}): Promise<boolean> {
  if (!S.session || !API) return false;
  if (syncing) return syncing;
  const today = isoDay(new Date());
  let { from, to } = S.cache && !around ? S.cache : rangeFor(around || today);
  // диапазон кэша уехал в прошлое - сдвигаем к сегодняшнему дню
  if (!around && (today < from || shift(today, 30) > to)) ({ from, to } = rangeFor(today));
  const sameRange = S.cache && S.cache.from === from && S.cache.to === to;
  const since = !force && sameRange ? S.cache!.ctag : "";

  S.syncing = true;
  emit("sync");
  syncing = (async () => {
    try {
      const q = new URLSearchParams({ from, to });
      if (since) q.set("since", since);
      const data = await api("GET", "/v1/events?" + q);
      S.error = null;
      if (data.unchanged) {
        setCache({ ...S.cache!, fetchedAt: new Date().toISOString() });
        return false;
      }
      const email = S.session!.user.email;
      if (data.user) { S.session!.user = data.user; store.set(K_SESSION, S.session); }
      setCache({ from, to, ctag: data.ctag, fetchedAt: data.fetchedAt, email, events: data.events.map(prepare) });
      // отметки, которые ещё сохраняются, не должны мигать старым статусом
      for (const [id, p] of S.pending) { const ev = find(id); if (ev) ev.partstat = p; }
      return true;
    } catch (e) {
      const err = e as ApiError;
      if (err.status !== 401) S.error = err.code === "network" ? "Нет связи, показано сохранённое расписание" : err.message;
      return false;
    } finally {
      S.syncing = false;
      syncing = null;
      emit("synced");
    }
  })();
  return syncing;
}

const covers = (day: string) => !!(S.cache && S.cache.from <= day && day <= S.cache.to);

// Дата вне загруженного диапазона: подгружаем диапазон вокруг неё.
// После неудачи ту же дату не запрашиваем чаще раза в 30 секунд.
let lastEnsure = { day: null as string | null, at: 0 };
function ensure(day: string) {
  if (!S.session || covers(day) || S.syncing) return;
  if (lastEnsure.day === day && Date.now() - lastEnsure.at < 30000) return;
  lastEnsure = { day, at: Date.now() };
  sync({ force: true, around: day });
}

const find = (id: string) => S.cache?.events.find((e) => e.id === id);

/* ---------- отметка присутствия */
async function rsvp(ev0: MyEvent, partstat: Partstat, scope: "one" | "series" = "one") {
  const ev = find(ev0.id) || ev0; // интерфейс может передать копию события
  const nowIso = new Date().toISOString();
  const targets = scope === "series"
    ? S.cache!.events.filter((e) => e.uid === ev.uid && (e.id === ev.id || e.start >= nowIso))
    : [ev];
  const before = targets.map((e) => [e, e.partstat] as const);
  for (const e of targets) { e.partstat = partstat; S.pending.set(e.id, partstat); }
  emit("rsvp");
  try {
    await api("POST", "/v1/rsvp", { href: ev.href, uid: ev.uid, recurrenceId: ev.recurrenceId, scope, partstat });
    store.set(K_EVENTS, S.cache);
  } catch (e) {
    for (const [x, p] of before) x.partstat = p;
    throw e;
  } finally {
    for (const e of targets) S.pending.delete(e.id);
    emit("rsvp");
  }
  // сервер мог создать замену для одного занятия: подтягиваем актуальное состояние
  setTimeout(() => sync({ force: true }), 1500);
}

/* ---------- фоновое обновление */
setInterval(() => { if (document.visibilityState === "visible") sync(); }, SYNC_EVERY);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !S.cache) return;
  if (Date.now() - Date.parse(S.cache.fetchedAt || "0") > SYNC_ON_FOCUS) sync();
});

export const account = {
  get enabled() { return !!API; },
  get user() { return S.session?.user ?? null; },
  get syncing() { return S.syncing; },
  get error() { return S.error; },
  get fetchedAt() { return S.cache?.fetchedAt ?? null; },
  isPending: (id: string) => S.pending.has(id),
  covers,
  eventsOn: (day: string) => S.byDate.get(day) || [],
  // вход по паролю приложения; вход через Яндекс ID добавится рядом и вызовет тот же login()
  loginWithPassword: (email: string, password: string) => login("caldav", { login: email, password }),
  logout,
  sync,
  ensure,
  rsvp,
  onChange: (fn: (why: string) => void) => { listeners.add(fn); return () => listeners.delete(fn); },
};

// Перерисовка компонентов при любом изменении аккаунта
export const useAccountVersion = () =>
  useSyncExternalStore((cb) => account.onChange(cb), () => version);
