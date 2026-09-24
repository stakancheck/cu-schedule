// Личное расписание: вход, кэш событий, синхронизация с Яндекс Календарём и отметки.
// Способ входа (пароль приложения сейчас, Яндекс ID потом) виден только в login();
// дальше везде одна и та же сессия, которую выдаёт API.
(function () {
  "use strict";

  const API = (window.CU_CONFIG && window.CU_CONFIG.api || "").replace(/\/$/, "");
  const K_SESSION = "cu.session", K_EVENTS = "cu.events";
  const PAST_DAYS = 14, AHEAD_DAYS = 120;
  const SYNC_EVERY = 5 * 60000, SYNC_ON_FOCUS = 60000;

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* приватный режим или нет места */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* приватный режим */ } },
  };

  /* ---------- время по Москве: так же считается общее расписание */
  const MSK = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  function msk(iso) {
    const p = {};
    for (const { type, value } of MSK.formatToParts(new Date(iso))) p[type] = value;
    return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, min: +p.hour * 60 + +p.minute };
  }
  const pad = (n) => String(n).padStart(2, "0");
  const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const shift = (day, n) => { const [y, m, d] = day.split("-").map(Number); return isoDay(new Date(y, m - 1, d + n)); };

  function prepare(ev) {
    const a = msk(ev.start), b = msk(ev.end);
    const e = b.date === a.date ? b.min : 24 * 60;
    return { ...ev, date: a.date, startHM: a.hm, endHM: b.date === a.date ? b.hm : "24:00", s: a.min, e: Math.max(e, a.min) };
  }

  /* ---------- состояние */
  const saved = store.get(K_SESSION);
  const S = {
    session: saved && saved.token ? saved : null,
    cache: null,             // { from, to, ctag, fetchedAt, events }
    byDate: new Map(),
    syncing: false,
    error: null,             // текст последней ошибки синхронизации
    pending: new Map(),      // id события -> отметка, которая ещё сохраняется
  };
  const listeners = new Set();
  const emit = (why) => listeners.forEach((fn) => { try { fn(why); } catch (e) { console.error(e); } });

  function index() {
    S.byDate = new Map();
    if (!S.cache) return;
    for (const ev of S.cache.events) {
      if (!S.byDate.has(ev.date)) S.byDate.set(ev.date, []);
      S.byDate.get(ev.date).push(ev);
    }
    for (const list of S.byDate.values()) list.sort((a, b) => a.s - b.s || a.e - b.e || a.title.localeCompare(b.title));
  }

  function setCache(c) {
    S.cache = c;
    index();
    if (c) store.set(K_EVENTS, c); else store.del(K_EVENTS);
  }

  if (S.session) {
    const c = store.get(K_EVENTS);
    // кэш другого пользователя не показываем
    if (c && c.email === S.session.user.email) { S.cache = c; index(); }
  }

  /* ---------- запросы */
  class ApiError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
  }

  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(API + path, {
        method,
        headers: {
          ...(body && { "Content-Type": "application/json" }),
          ...(S.session && { Authorization: "Bearer " + S.session.token }),
        },
        body: body && JSON.stringify(body),
      });
    } catch (e) {
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
  async function login(provider, fields) {
    S.session = null;
    const data = await api("POST", "/v1/session", { provider, ...fields });
    S.session = { token: data.token, user: data.user };
    store.set(K_SESSION, S.session);
    S.error = null;
    setCache(null);
    emit("login");
    await sync({ force: true });
    return data.user;
  }

  function logout() {
    S.session = null;
    store.del(K_SESSION);
    setCache(null);
    S.pending.clear();
    emit("logout");
  }

  /* ---------- синхронизация */
  let syncing = null;
  function rangeFor(day) {
    return { from: shift(day, -PAST_DAYS), to: shift(day, AHEAD_DAYS) };
  }

  async function sync({ force = false, around } = {}) {
    if (!S.session || !API) return false;
    if (syncing) return syncing;
    const today = isoDay(new Date());
    let { from, to } = S.cache && !around ? S.cache : rangeFor(around || today);
    // диапазон кэша уехал в прошлое - сдвигаем к сегодняшнему дню
    if (!around && (today < from || shift(today, 30) > to)) ({ from, to } = rangeFor(today));
    const sameRange = S.cache && S.cache.from === from && S.cache.to === to;
    const since = !force && sameRange ? S.cache.ctag : "";

    S.syncing = true;
    emit("sync");
    syncing = (async () => {
      try {
        const q = new URLSearchParams({ from, to });
        if (since) q.set("since", since);
        const data = await api("GET", "/v1/events?" + q);
        S.error = null;
        if (data.unchanged) {
          setCache({ ...S.cache, fetchedAt: new Date().toISOString() });
          return false;
        }
        const email = S.session.user.email;
        if (data.user) { S.session.user = data.user; store.set(K_SESSION, S.session); }
        setCache({ from, to, ctag: data.ctag, fetchedAt: data.fetchedAt, email, events: data.events.map(prepare) });
        // отметки, которые ещё сохраняются, не должны мигать старым статусом
        for (const [id, p] of S.pending) { const ev = find(id); if (ev) ev.partstat = p; }
        return true;
      } catch (e) {
        if (e.status !== 401) S.error = e.code === "network" ? "Нет связи, показано сохранённое расписание" : e.message;
        return false;
      } finally {
        S.syncing = false;
        syncing = null;
        emit("synced");
      }
    })();
    return syncing;
  }

  function covers(day) {
    return !!(S.cache && S.cache.from <= day && day <= S.cache.to);
  }

  // Дата вне загруженного диапазона: подгружаем диапазон вокруг неё.
  // После неудачи ту же дату не запрашиваем чаще раза в 30 секунд.
  let lastEnsure = { day: null, at: 0 };
  function ensure(day) {
    if (!S.session || covers(day) || S.syncing) return;
    if (lastEnsure.day === day && Date.now() - lastEnsure.at < 30000) return;
    lastEnsure = { day, at: Date.now() };
    sync({ force: true, around: day });
  }

  const find = (id) => S.cache && S.cache.events.find((e) => e.id === id);

  /* ---------- отметка присутствия */
  async function rsvp(ev, partstat, scope = "one") {
    ev = find(ev.id) || ev; // интерфейс может передать копию события
    const nowIso = new Date().toISOString();
    const targets = scope === "series"
      ? S.cache.events.filter((e) => e.uid === ev.uid && (e.id === ev.id || e.start >= nowIso))
      : [ev];
    const before = targets.map((e) => [e, e.partstat]);
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
    if (Date.now() - Date.parse(S.cache.fetchedAt || 0) > SYNC_ON_FOCUS) sync();
  });

  window.CUAccount = {
    get enabled() { return !!API; },
    get user() { return S.session && S.session.user; },
    get syncing() { return S.syncing; },
    get error() { return S.error; },
    get fetchedAt() { return S.cache && S.cache.fetchedAt; },
    isPending: (id) => S.pending.has(id),
    covers,
    eventsOn: (day) => S.byDate.get(day) || [],
    // вход по паролю приложения; вход через Яндекс ID добавится рядом и вызовет тот же login()
    loginWithPassword: (email, password) => login("caldav", { login: email, password }),
    logout,
    sync,
    ensure,
    rsvp,
    onChange: (fn) => listeners.add(fn),
  };
})();
