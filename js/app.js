(function () {
  "use strict";

  const DAY_START = 8 * 60;   // границы «рабочего дня» для свободных окон
  const DAY_END = 22 * 60;
  const SOON_MIN = 30;        // «скоро пара», если до начала меньше получаса
  const MIN_WINDOW = 15;      // окна короче не показываем

  const CAMPUSES = window.CAMPUSES;
  let campus = CAMPUSES.CT;
  const SVGNS = "http://www.w3.org/2000/svg";
  const $ = (id) => document.getElementById(id);

  /* ============================================================ Telegram Mini App */
  const tg = window.Telegram && window.Telegram.WebApp;
  // вне Telegram скрипт тоже грузится, но platform = "unknown"
  const inTg = !!(tg && tg.platform && tg.platform !== "unknown");
  const tgAt = (v) => inTg && tg.isVersionAtLeast(v);

  function syncTgColors() {
    if (!tgAt("6.1")) return;
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
    if (!/^#[0-9a-f]{6}$/i.test(bg)) return;
    tg.setHeaderColor(bg);
    tg.setBackgroundColor(bg);
    if (tgAt("7.10")) tg.setBottomBarColor(bg);
  }

  function initTelegram() {
    if (!inTg) return;
    document.documentElement.classList.add("tma");
    tg.ready();
    tg.expand();
    // иначе перетаскивание плана вниз сворачивает мини-апп
    if (tgAt("7.7")) tg.disableVerticalSwipes();
    if (tgAt("6.1")) tg.BackButton.onClick(() => {
      if (state.view !== "plan" && isPhone()) setView("plan");
      else selectRoom(null);
    });
    // внешние ссылки открываем через Telegram, а не внутри мини-аппа
    document.addEventListener("click", (e) => {
      const a = e.target.closest && e.target.closest('a[target="_blank"]');
      if (!a) return;
      e.preventDefault();
      // ссылки на Telegram открываем нативно, остальные во внешнем браузере
      if (/^https:\/\/t\.me\//.test(a.href)) tg.openTelegramLink(a.href);
      else tg.openLink(a.href);
    });
  }

  function syncTgBackButton() {
    if (!tgAt("6.1")) return;
    const offPlan = state.view !== "plan" && window.matchMedia("(max-width: 900px)").matches;
    if (state.room || offPlan) tg.BackButton.show(); else tg.BackButton.hide();
  }

  /* ============================================================ Данные */
  const toMin = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
  const fmt = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

  const S = window.SCHEDULE;
  const str = S.strings;

  // Аудитории с расписанием: в ЦТ это class-комнаты, в Дукате - помещения
  // из PDF-плана, которые встречаются в расписании. Коды уникальны между кампусами.
  const scheduled = new Set();
  for (const row of S.events) for (const i of row[7]) scheduled.add(str[i]);
  const roomFloor = {}, roomCampus = {};
  for (const c of Object.values(CAMPUSES)) {
    for (const f of Object.values(c.floors)) {
      for (const r of f.rooms) {
        const isClass = r.kind === "class" || (r.pts && r.pts.length && scheduled.has(r.id));
        if (isClass) { roomFloor[r.id] = f.n; roomCampus[r.id] = c.id; }
      }
    }
    // рамка кампуса: у ЦТ задана, у Дуката собираем из рамок этажей
    if (!c.extent) {
      const e = Object.values(c.floors).map((f) => f.extent);
      const x0 = Math.min(...e.map((v) => v[0])), y0 = Math.min(...e.map((v) => v[1]));
      const x1 = Math.max(...e.map((v) => v[2])), y1 = Math.max(...e.map((v) => v[3]));
      c.extent = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    }
  }
  const floorNums = (c) => Object.keys(c.floors).map(Number).sort((a, b) => a - b);
  // первый этаж, где есть аудитории с расписанием
  const defaultFloor = (c) => floorNums(c).find((n) =>
    Object.keys(roomFloor).some((r) => roomCampus[r] === c.id && roomFloor[r] === n)) || floorNums(c)[0];
  const byDate = new Map(); // date -> [event]
  let dataMin = "9999", dataMax = "0000";
  for (const row of S.events) {
    const [date, start, end, title, course, type, stream, rooms, teachers] = row;
    if (date < dataMin) dataMin = date;
    if (date > dataMax) dataMax = date;
    const rs = rooms.map((i) => str[i]).filter((r) => roomFloor[r]);
    if (!rs.length) continue;
    const ev = {
      date, start, end, s: toMin(start), e: toMin(end),
      title: str[title], course: str[course], type: str[type],
      stream: str[stream], teachers: str[teachers], rooms: rs, campus: roomCampus[rs[0]],
    };
    ev.search = `${ev.title} ${ev.course} ${ev.stream} ${ev.teachers} ${rs.join(" ")}`.toLowerCase();
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(ev);
  }
  for (const list of byDate.values()) {
    list.sort((a, b) => a.s - b.s || a.e - b.e || a.rooms[0].localeCompare(b.rooms[0]));
  }

  // Занятость по аудиториям на дату, с объединением стыкующихся пар
  const occCache = new Map();
  function occupancy(date) {
    if (occCache.has(date)) return occCache.get(date);
    const map = {};
    for (const ev of byDate.get(date) || []) {
      for (const r of ev.rooms) (map[r] ||= []).push(ev);
    }
    const res = {};
    for (const [room, evs] of Object.entries(map)) {
      evs.sort((a, b) => a.s - b.s);
      const merged = [];
      for (const ev of evs) {
        const last = merged[merged.length - 1];
        if (last && ev.s <= last.e) { last.e = Math.max(last.e, ev.e); last.evs.push(ev); }
        else merged.push({ s: ev.s, e: ev.e, evs: [ev] });
      }
      res[room] = merged;
    }
    occCache.set(date, res);
    return res;
  }

  function roomStatus(room, date, t) {
    const blocks = occupancy(date)[room] || [];
    for (const b of blocks) {
      if (b.s <= t && t < b.e) {
        const cur = b.evs.find((ev) => ev.s <= t && t < ev.e) || b.evs[0];
        return { st: "busy", until: b.e, ev: cur };
      }
      if (b.s > t) {
        return { st: b.s - t <= SOON_MIN ? "soon" : "free", until: b.s, next: b.evs[0] };
      }
    }
    return { st: "free", until: null };
  }

  function freeWindows(room, date) {
    const blocks = occupancy(date)[room] || [];
    const out = [];
    let cur = DAY_START;
    for (const b of blocks) {
      if (b.s - cur >= MIN_WINDOW) out.push([cur, Math.min(b.s, DAY_END)]);
      cur = Math.max(cur, b.e);
    }
    if (DAY_END - cur >= MIN_WINDOW) out.push([cur, DAY_END]);
    return out;
  }

  /* ============================================================ Мои пары (Яндекс Календарь) */
  const A = window.CUAccount;
  const norm = (s) => (s || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();

  // Преподавателей и поток в календаре нет: берём из общей базы по дате, времени и предмету
  const extras = new Map();
  function enrich(ev) {
    const key = `${ev.date}|${ev.startHM}|${ev.title}|${ev.rooms.join()}`;
    if (!extras.has(key)) {
      const cands = (byDate.get(ev.date) || []).filter((c) => c.start === ev.startHM && norm(c.title) === norm(ev.title));
      const hit = cands.find((c) => c.rooms.some((r) => ev.rooms.includes(r))) || (cands.length === 1 ? cands[0] : null);
      extras.set(key, { teachers: hit ? hit.teachers : "", stream: hit ? hit.stream : "", known: ev.rooms.filter((r) => roomFloor[r]) });
    }
    // статус отметки меняется, поэтому берём его из свежего события, а не из кэша
    return { ...ev, ...extras.get(key) };
  }
  const myEvents = (date) => (A.user ? A.eventsOn(date).map(enrich) : []);

  function myRooms(date) {
    const out = new Map(); // аудитория -> пары в ней
    for (const ev of myEvents(date)) {
      if (ev.partstat === "DECLINED") continue;
      for (const r of ev.known) (out.get(r) || out.set(r, []).get(r)).push(ev);
    }
    return out;
  }

  /* ============================================================ Даты */
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseIso = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parseIso(s); d.setDate(d.getDate() + n); return iso(d); };
  const todayIso = () => iso(new Date());
  const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
  const dowFmt = new Intl.DateTimeFormat("ru-RU", { weekday: "long" });
  const dayFmt = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });
  const ghostFmt = new Intl.DateTimeFormat("ru-RU", { weekday: "short", day: "numeric" });
  const OTHER_DAY_T = 10 * 60; // другой день открываем на 10:00, а не на текущем времени
  const isPhone = () => window.matchMedia("(max-width: 900px)").matches;

  /* ============================================================ Состояние */
  const state = {
    campus: "CT",
    floor: 3,
    date: todayIso(),
    t: nowMin(),
    live: true,
    room: null,
    angle: 0,       // поворот плана, градусы (кратно 90)
    zoom: 1,
    pan: [0, 0],
    scope: "all",
    query: "",
    showPast: false,
    view: "plan",   // вкладка мобильной версии: plan | list | info
    mine: false,    // список: мои пары или все
  };
  try {
    const m = localStorage.getItem("cu.mode");
    state.mine = A.enabled && (m ? m === "mine" : !!A.user);
  } catch (e) { state.mine = A.enabled && !!A.user; }

  (function readHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    if (CAMPUSES[h.get("c")]) { state.campus = h.get("c"); campus = CAMPUSES[state.campus]; state.floor = defaultFloor(campus); }
    if (h.get("f") && campus.floors[h.get("f")]) state.floor = +h.get("f");
    if (/^\d{4}-\d\d-\d\d$/.test(h.get("d") || "")) state.date = h.get("d");
    if (h.get("r") && roomFloor[h.get("r")]) {
      state.room = h.get("r");
      state.campus = roomCampus[state.room]; campus = CAMPUSES[state.campus];
      state.floor = roomFloor[state.room];
    }
    if (h.get("rot")) state.angle = ((+h.get("rot") % 360) + 360) % 360;
    if (h.get("t") && /^\d\d:\d\d$/.test(h.get("t"))) { state.t = toMin(h.get("t")); state.live = false; }
    else if (state.date !== todayIso()) { state.t = OTHER_DAY_T; state.live = false; }
    if (["list", "info"].includes(h.get("v"))) state.view = h.get("v");
  })();

  function writeHash() {
    const h = new URLSearchParams();
    if (state.campus !== "CT") h.set("c", state.campus);
    h.set("f", state.floor);
    if (state.date !== todayIso()) h.set("d", state.date);
    if (!state.live) h.set("t", fmt(state.t));
    if (state.room) h.set("r", state.room);
    if (state.angle) h.set("rot", ((state.angle % 360) + 360) % 360);
    if (state.view !== "plan") h.set("v", state.view);
    history.replaceState(null, "", "#" + h.toString());
  }

  /* ============================================================ План */
  const svg = $("plan");
  let world, labels = [], streetLabels = [], roomEls = {}, roomLabelEls = {};

  function el(tag, attrs, parent) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  const ptsAttr = (pts) => pts.map((p) => p.join(",")).join(" ");
  function centroid(pts) {
    // центр масс многоугольника
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
      const k = x0 * y1 - x1 * y0;
      a += k; cx += (x0 + x1) * k; cy += (y0 + y1) * k;
    }
    a /= 2;
    return a ? [cx / (6 * a), cy / (6 * a)] : pts[0];
  }

  // Подпись, которая всегда стоит вертикально при повороте плана
  function upright(parent, x, y) {
    const g = el("g", {}, parent);
    labels.push({ g, x, y });
    return g;
  }

  function tag(parent, text, { size = 14, cls = "", padX = 8, h } = {}) {
    const g = el("g", { class: cls }, parent);
    const w = Math.max(text.length * size * 0.58 + padX * 2, h || 0);
    const hh = h || size * 1.9;
    el("rect", { class: "tagbox", x: -w / 2, y: -hh / 2, width: w, height: hh, rx: 3 }, g);
    const t = el("text", { class: "tagtxt", "font-size": size }, g);
    t.textContent = text;
    return g;
  }

  const ICONS = {
    stairs: "M-7,6 h4 v-4 h4 v-4 h4 v-4 h2",
    lift: "M-5,-2 L0,-8 L5,-2 Z M-5,2 L0,8 L5,2 Z",
    vending: "M-5,-7 h10 v14 h-10 Z M-2,-3 h4 M-2,1 h4",
    cafe: "M-6,-3 h10 v5 a5,5 0 0 1 -10,0 Z M4,-1 h2 a2,2 0 0 1 0,4 h-2",
    wardrobe: "M0,-6 a2,2 0 1 1 2,2 v2 L8,4 H-8 L-2,-2",
  };
  function poi(parent, p) {
    if (p.kind === "tag") {
      const g = upright(parent, p.x, p.y);
      tag(g, p.text, { size: 13, cls: "tag-mini" });
      return;
    }
    const g = upright(parent, p.x, p.y);
    g.setAttribute("class", "poi " + p.kind);
    el("rect", { x: -14, y: -14, width: 28, height: 28, rx: 3 }, g);
    if (ICONS[p.kind]) el("path", { d: ICONS[p.kind] }, g);
    else if (p.kind === "info") { el("circle", { class: "ic", r: 8 }, g); el("text", { y: 1, "font-size": 12 }, g).textContent = "i"; }
    else {
      const txt = { wcm: "М", wcf: "Ж", access: "♿︎" }[p.kind] || "?";
      el("text", { y: 1 }, g).textContent = txt;
    }
  }

  function buildPlan() {
    const floor = campus.floors[state.floor];
    svg.innerHTML = "";
    labels = []; streetLabels = []; roomEls = {}; roomLabelEls = {};

    const defs = el("defs", {}, svg);
    const pat = el("pattern", { id: "hatch", width: 10, height: 10, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, defs);
    el("rect", { width: 10, height: 10, fill: "var(--floor)" }, pat);
    el("rect", { width: 4, height: 10, fill: "var(--wip)", opacity: .35 }, pat);

    world = el("g", {}, svg);
    if (floor.floorPaths) { buildVectorFloor(floor); applyTransform(); paintRooms(); return; }

    // Улицы (в базовых координатах)
    for (const line of campus.streets.lines) el("polyline", { class: "street-line", points: ptsAttr(line) }, world);
    for (const s of campus.streets.labels) {
      const g = el("g", {}, world);
      const t = el("text", { class: "street-lbl" }, g);
      t.textContent = s.text;
      streetLabels.push({ g, ...s });
    }
    const m = campus.streets.metro;
    el("path", { class: "metro-arrow", d: `M${m.x},${m.y - 30} v38 m-9,-10 l9,10 l9,-10` }, world);
    const mg = upright(world, m.x, m.y + 40);
    m.text.forEach((line, i) => { el("text", { class: "metro-lbl", y: i * 26 }, mg).textContent = line; });

    // Этаж
    const fg = el("g", { transform: `translate(${floor.offset[0]},${floor.offset[1]})` }, world);
    el("path", { class: "b-outline", d: floor.outline }, fg);

    const roomsG = el("g", { class: "rooms" + (state.room ? " has-sel" : "") }, fg);
    for (const r of floor.rooms) {
      if (r.kind === "class") continue;
      el("polygon", { class: "r " + r.kind, points: ptsAttr(r.pts) }, roomsG);
    }
    for (const w of floor.walls) el("polyline", { class: "b-wall", points: ptsAttr(w) }, fg);
    el("polygon", { class: "b-atrium", points: ptsAttr(floor.atrium) }, fg);

    // Учебные аудитории поверх стен, чтобы кликались целиком
    const classG = el("g", { class: "rooms" + (state.room ? " has-sel" : "") }, fg);
    for (const r of floor.rooms) {
      if (r.kind !== "class") continue;
      const poly = el("polygon", { class: "r class", points: ptsAttr(r.pts), "data-room": r.id }, classG);
      roomEls[r.id] = poly;
    }

    // Атриум
    const [ax, ay] = centroid(floor.atrium);
    tag(upright(fg, ax, ay), "Атриум", { size: 20, cls: "atrium-lbl", padX: 14 });

    // POI
    const poiG = el("g", {}, fg);
    for (const p of floor.pois) poi(poiG, p);

    // Подписи помещений
    for (const r of floor.rooms) {
      if (r.kind === "class") {
        roomLabel(fg, r, r.labelAt || centroid(r.pts));
      } else if (r.label && r.kind !== "service" || r.tag) {
        if (!r.label) continue;
        const [cx, cy] = r.tag || centroid(r.pts);
        const g = upright(fg, cx, cy);
        const k = r.tagKind === "dark" ? "" : ({ kitchen: "tag-kitchen", staff: "tag-staff", wip: "tag-wip" }[r.kind] || "");
        const tagEl = tag(g, r.label, { size: 13, cls: k });
        if (r.vertical) tagEl.setAttribute("transform", "rotate(-90)");
        tagEl.style.pointerEvents = "none";
      }
    }

    applyTransform();
    paintRooms();
  }

  /* ---------- этаж из PDF (Дукат): готовые векторы стен, иконок и подписей */
  const TAG_CLS = { kitchen: "tag-kitchen", staff: "tag-staff", fitness: "tag-fitness", closed: "tag-closed", health: "tag-health" };
  const ROOM_FILL = { kitchen: "kitchen", staff: "staff", fitness: "fitness", closed: "closed", health: "health" };
  const isCowork = (r) => /Коворкинг/.test(r.label || r.text || "") && !/сотрудник/.test(r.label || r.text || "");
  const short = (t, n = 26) => (t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t);

  function buildVectorFloor(floor) {
    const fg = el("g", {}, world);
    const eo = (p) => (p.eo ? "evenodd" : "nonzero");
    for (const p of floor.floorPaths) el("path", { class: "v-floor", d: p.d, "fill-rule": eo(p) }, fg);

    const roomsG = el("g", { class: "rooms" }, fg);
    for (const r of floor.rooms) {
      if (!r.pts.length || roomFloor[r.id]) continue;
      const k = ROOM_FILL[r.color] || (isCowork(r) ? "open" : "plain");
      el("polygon", { class: "r v " + k, points: ptsAttr(r.pts) }, roomsG);
    }
    for (const p of floor.wallPaths) el("path", { class: "v-wall", d: p.d, "fill-rule": eo(p) }, fg);
    for (const p of floor.voidPaths) el("path", { class: "v-void", d: p.d, "fill-rule": eo(p) }, fg);

    const classG = el("g", { class: "rooms" }, fg);
    for (const r of floor.rooms) {
      if (!roomFloor[r.id]) continue;
      roomEls[r.id] = el("polygon", { class: "r v class", points: ptsAttr(r.pts), "data-room": r.id }, classG);
    }

    for (const ic of floor.icons) {
      const g = upright(fg, ic.x, ic.y);
      g.setAttribute("class", "vicon");
      for (const p of ic.parts) el("path", { class: "ic-" + p.c, d: p.d, "fill-rule": eo(p) }, g);
    }

    for (const l of floor.labels) {
      const g = upright(fg, l.x, l.y);
      const cls = isCowork(l) ? "tag-open" : TAG_CLS[l.color] || "";
      tag(g, l.text, { size: l.big ? 30 : 12, cls, padX: l.big ? 14 : 7 }).style.pointerEvents = "none";
    }

    for (const r of floor.rooms) {
      if (roomFloor[r.id]) {
        roomLabel(fg, r, centroid(r.pts));
      } else {
        const [x, y] = r.tag;
        const g = upright(fg, x, y);
        const text = r.label ? `${short(r.label)} · ${r.id}` : r.id;
        const tagEl = tag(g, text, { size: 11, cls: isCowork(r) ? "tag-open" : TAG_CLS[r.color] || "", padX: 6 });
        el("title", {}, tagEl).textContent = r.label ? `${r.id}: ${r.label}` : r.id;
      }
    }
  }

  function roomLabel(parent, r, [cx, cy]) {
    const g = upright(parent, cx, cy);
    g.setAttribute("class", "room-lbl");
    const code = r.id;
    const w = code.length * 10.6 + 24;
    el("rect", { class: "tagbox", x: -w / 2, y: -14, width: w, height: 26, rx: 4 }, g);
    el("circle", { class: "dot", cx: -w / 2 + 9, cy: -1, r: 4 }, g);
    el("text", { class: "tagtxt code", x: 5, y: -1 }, g).textContent = code;
    const sub = el("text", { class: "sub", y: 27, "text-anchor": "middle" }, g);
    roomLabelEls[r.id] = { g, sub, dot: g.querySelector(".dot") };
  }

  /* ---------- поворот и масштаб */
  let viewAngle = state.angle; // текущий угол анимации
  let CX, CY;
  function updateCenter() {
    const xs = campus.extent.map((p) => p[0]), ys = campus.extent.map((p) => p[1]);
    CX = (Math.min(...xs) + Math.max(...xs)) / 2;
    CY = (Math.min(...ys) + Math.max(...ys)) / 2;
  }
  updateCenter();

  function applyTransform() {
    const a = viewAngle;
    world.setAttribute("transform", `rotate(${a} ${CX} ${CY})`);
    for (const l of labels) l.g.setAttribute("transform", `translate(${l.x},${l.y}) rotate(${-a})`);
    for (const s of streetLabels) {
      let v = ((s.angle + a) % 360 + 360) % 360;
      if (v > 90 && v <= 270) v -= 180;
      s.g.setAttribute("transform", `translate(${s.x},${s.y}) rotate(${v - a})`);
    }
    // рамка по повернутому extent
    const rad = (a * Math.PI) / 180, c = Math.cos(rad), s = Math.sin(rad);
    const rp = campus.extent.map(([x, y]) => [CX + (x - CX) * c - (y - CY) * s, CY + (x - CX) * s + (y - CY) * c]);
    const xs = rp.map((p) => p[0]), ys = rp.map((p) => p[1]);
    const bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...ys) - Math.min(...ys);
    const w = bw / state.zoom, h = bh / state.zoom;
    const cx = CX + state.pan[0], cy = CY + state.pan[1];
    svg.setAttribute("viewBox", `${cx - w / 2} ${cy - h / 2} ${w} ${h}`);
    $("needle").setAttribute("transform", `rotate(${a})`);
    $("compassN").setAttribute("transform", `rotate(${a}) translate(0,-4.5) rotate(${-a}) translate(0,4.5)`);
  }

  function rotateTo(target) {
    const from = viewAngle, t0 = performance.now(), dur = 380;
    state.angle = target;
    writeHash();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      viewAngle = from + (target - from) * e;
      applyTransform();
      if (k < 1) requestAnimationFrame(step);
      else { viewAngle = target; applyTransform(); }
    };
    requestAnimationFrame(step);
  }
  $("rotL").onclick = () => rotateTo(state.angle - 90);
  $("rotR").onclick = () => rotateTo(state.angle + 90);
  $("compass").onclick = () => {
    // на телефоне компас - единственная кнопка поворота, крутит по часовой
    if (isPhone()) return rotateTo(state.angle + 90);
    const a = state.angle % 360;
    rotateTo(state.angle - (a > 180 ? a - 360 : a < -180 ? a + 360 : a));
  };

  function svgPoint(clientX, clientY) {
    const p = svg.createSVGPoint();
    p.x = clientX; p.y = clientY;
    return p.matrixTransform(svg.getScreenCTM().inverse());
  }
  function zoomAt(factor, clientX, clientY) {
    focusAnim++; // ручной масштаб отменяет наведение на аудиторию
    const before = clientX != null ? svgPoint(clientX, clientY) : null;
    state.zoom = Math.min(6, Math.max(1, state.zoom * factor));
    if (state.zoom === 1) state.pan = [0, 0];
    applyTransform();
    if (before && state.zoom > 1) {
      const after = svgPoint(clientX, clientY);
      state.pan[0] += before.x - after.x;
      state.pan[1] += before.y - after.y;
      applyTransform();
    }
  }
  // Плавно приблизить план к аудитории: центр комнаты в центр экрана с учётом поворота.
  // На телефоне комнату ставим выше центра, чтобы её не закрывала карточка снизу.
  let focusAnim = 0;
  function focusRoom(room) {
    const floor = campus.floors[state.floor];
    const r = floor && floor.rooms.find((x) => x.id === room);
    if (!r || !r.pts || !r.pts.length) return;
    // габариты берём из данных: у скрытого плана (вкладка списка) getBBox вернёт нули
    const off = floor.floorPaths ? [0, 0] : floor.offset;
    const xs = r.pts.map((p) => p[0]), ys = r.pts.map((p) => p[1]);
    const b = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    const x = b.x + b.width / 2 + off[0], y = b.y + b.height / 2 + off[1];
    const rad = (state.angle * Math.PI) / 180, c = Math.cos(rad), s = Math.sin(rad);
    const rx = CX + (x - CX) * c - (y - CY) * s, ry = CY + (x - CX) * s + (y - CY) * c;

    // размер вида при zoom = 1 (как в applyTransform)
    const rp = campus.extent.map(([px, py]) => [CX + (px - CX) * c - (py - CY) * s, CY + (px - CX) * s + (py - CY) * c]);
    const bw = Math.max(...rp.map((p) => p[0])) - Math.min(...rp.map((p) => p[0]));
    const bh = Math.max(...rp.map((p) => p[1])) - Math.min(...rp.map((p) => p[1]));
    // Масштаб от реального размера плана на экране: комната занимает около четверти
    // меньшей стороны (при preserveAspectRatio=meet в пикселях видно min(W/bw, H/bh) * zoom)
    const box = svg.getBoundingClientRect();
    const W = box.width || 800, H = box.height || 600;
    const fit = Math.min(W / bw, H / bh);
    const size = Math.max(b.width, b.height, 1);
    const zoom = Math.min(4.5, Math.max(1.6, (0.25 * Math.min(W, H)) / (size * fit)));
    // на телефоне поднимаем комнату над мини-карточкой снизу
    const lift = isPhone() ? (H / (fit * zoom)) * 0.1 : 0;
    const target = { zoom, pan: [rx - CX, ry - CY + lift] };

    const from = { zoom: state.zoom, pan: [...state.pan] };
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t0 = performance.now(), dur = reduce ? 0 : 520, id = ++focusAnim;
    const step = (now) => {
      if (id !== focusAnim) return; // началась новая анимация
      const k = dur ? Math.min(1, (now - t0) / dur) : 1;
      const e = 1 - Math.pow(1 - k, 3);
      state.zoom = from.zoom + (target.zoom - from.zoom) * e;
      state.pan = [from.pan[0] + (target.pan[0] - from.pan[0]) * e, from.pan[1] + (target.pan[1] - from.pan[1]) * e];
      applyTransform();
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  $("zoomIn").onclick = () => zoomAt(1.4);
  $("zoomOut").onclick = () => zoomAt(1 / 1.4);
  svg.addEventListener("wheel", (e) => { e.preventDefault(); zoomAt(Math.exp(-e.deltaY * 0.0022), e.clientX, e.clientY); }, { passive: false });

  // Перетаскивание (клик отличаем от драга по сдвигу)
  let drag = null;
  const pointers = new Map();
  svg.addEventListener("pointerdown", (e) => {
    focusAnim++;
    if (e.pointerType !== "mouse") hideTip();
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      drag = { pinch: Math.hypot(a[0] - b[0], a[1] - b[1]), moved: true };
      return;
    }
    drag = { x: e.clientX, y: e.clientY, moved: false, target: e.target };
  });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (drag.pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      zoomAt(d / drag.pinch, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      drag.pinch = d;
      return;
    }
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    if (!drag.moved) { drag.moved = true; svg.setPointerCapture(e.pointerId); svg.classList.add("dragging"); hideTip(); }
    if (state.zoom > 1) {
      const p0 = svgPoint(drag.x, drag.y), p1 = svgPoint(e.clientX, e.clientY);
      state.pan[0] -= p1.x - p0.x;
      state.pan[1] -= p1.y - p0.y;
      applyTransform();
    }
    drag.x = e.clientX; drag.y = e.clientY;
  });
  const endDrag = (e) => {
    pointers.delete(e.pointerId);
    if (!drag) return;
    const d = drag;
    if (pointers.size === 0) { drag = null; svg.classList.remove("dragging"); }
    if (!d.moved && e.type === "pointerup") {
      const room = d.target.closest && d.target.closest("[data-room]");
      if (room) selectRoom(room.dataset.room === state.room ? null : room.dataset.room);
    }
  };
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);

  /* ---------- подсказка */
  const tip = $("tooltip");
  function hideTip() { tip.hidden = true; }
  // Подсказка только для мыши: на тач-экране pointerover срабатывает при каждом
  // касании (скролл, зум), а информацию по тапу и так показывает карточка аудитории.
  svg.addEventListener("pointerover", (e) => {
    if (e.pointerType !== "mouse") return;
    const r = e.target.closest && e.target.closest("[data-room]");
    if (!r || drag) return;
    const room = r.dataset.room, st = roomStatus(room, state.date, state.t);
    let html = `<b>${room}</b><br>`;
    if (st.st === "busy") html += `Занята до ${fmt(st.until)}<br><span style="opacity:.8">${esc(st.ev.title)}</span>`;
    else if (st.until) html += `Свободна до ${fmt(st.until)}<br><span style="opacity:.8">Дальше: ${esc(st.next.title)}</span>`;
    else html += "Свободна до конца дня";
    tip.innerHTML = html;
    tip.hidden = false;
  });
  svg.addEventListener("pointermove", (e) => {
    if (tip.hidden) return;
    const box = $("planWrap").getBoundingClientRect();
    let x = e.clientX - box.left + 14, y = e.clientY - box.top + 14;
    if (x + 260 > box.width) x = e.clientX - box.left - 14 - tip.offsetWidth;
    tip.style.left = x + "px"; tip.style.top = y + "px";
  });
  svg.addEventListener("pointerout", (e) => {
    if (e.target.closest && e.target.closest("[data-room]")) hideTip();
  });

  function paintRooms() {
    const mine = myRooms(state.date);
    for (const [room, poly] of Object.entries(roomEls)) {
      const st = roomStatus(room, state.date, state.t);
      poly.classList.remove("free", "soon", "busy");
      poly.classList.add(st.st);
      poly.classList.toggle("sel", room === state.room);
      poly.classList.toggle("mine", mine.has(room));
      const lab = roomLabelEls[room];
      lab.g.classList.toggle("mine", mine.has(room));
      lab.dot.setAttribute("class", "dot dot-" + st.st);
      lab.sub.setAttribute("class", "sub dot-" + st.st);
      lab.sub.textContent = st.st === "busy" ? `до ${fmt(st.until)}` : st.until ? `своб. до ${fmt(st.until)}` : "свободна";
    }
    svg.querySelectorAll(".rooms").forEach((g) => g.classList.toggle("has-sel", !!state.room));
    document.querySelector(".lg-mine").hidden = !mine.size;
  }

  /* ============================================================ Правая колонка */
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function renderFloorSeg() {
    const seg = $("floorSeg");
    seg.innerHTML = "";
    seg.classList.toggle("many", floorNums(campus).length > 4);
    const mine = [...myRooms(state.date).keys()];
    const myFloors = new Set(mine.filter((r) => roomCampus[r] === state.campus).map((r) => roomFloor[r]));
    for (const n of floorNums(campus)) {
      const b = document.createElement("button");
      b.innerHTML = `${n}<span class="fl-w"> этаж</span>`;
      b.title = myFloors.has(n) ? `${n} этаж: здесь ваши пары` : `${n} этаж`;
      b.className = (+n === state.floor ? "on" : "") + (myFloors.has(n) ? " has-mine" : "");
      b.onclick = () => setFloor(+n);
      seg.appendChild(b);
    }
    const f = campus.floors[state.floor];
    $("floorN").textContent = `Этаж ${state.floor}`;
    $("floorSum").textContent = f.summary || autoSummary(f);
    const myCampuses = new Set(mine.map((r) => roomCampus[r]));
    $("campusSeg").querySelectorAll("button").forEach((b) => {
      b.classList.toggle("on", b.dataset.campus === state.campus);
      b.classList.toggle("has-mine", myCampuses.has(b.dataset.campus));
    });
  }

  function autoSummary(f) {
    const rooms = f.rooms.filter((r) => roomFloor[r.id]).map((r) => r.id);
    const extra = [...new Set([...f.rooms.map((r) => r.label), ...f.labels.map((l) => l.text)]
      .filter((t) => /^(Коворкинг|Кафе|Кухня|Библиотека|Зона отдыха)/.test(t || ""))
      .map((t) => t.split(/[ /]/)[0].toLowerCase()))];
    const parts = [];
    if (rooms.length) parts.push(`Аудитории ${rooms.join(", ")}`);
    if (extra.length) parts.push(extra.join(", "));
    return parts.join("; ") || "Пар по расписанию на этаже нет";
  }

  function renderHead() {
    const d = parseIso(state.date);
    $("dow").textContent = dowFmt.format(d);
    $("dnum").textContent = dayFmt.format(d);
    $("datePick").value = state.date;
    $("prevLbl").textContent = ghostFmt.format(parseIso(addDays(state.date, -1)));
    $("nextLbl").textContent = ghostFmt.format(parseIso(addDays(state.date, 1)));
    const today = todayIso();
    const q = $("quickDays");
    q.innerHTML = "";
    [["Вчера", addDays(today, -1)], ["Сегодня", today], ["Завтра", addDays(today, 1)]].forEach(([label, v]) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.className = v === state.date ? "on" : "";
      b.onclick = () => setDate(v);
      q.appendChild(b);
    });
    $("timeVal").textContent = fmt(state.t);
    $("timeRange").value = Math.min(DAY_END, Math.max(DAY_START, state.t));
    $("nowBtn").classList.toggle("on", state.live);
  }

  function renderPeek() {
    const peek = $("roomPeek");
    peek.hidden = !state.room;
    if (!state.room) { peek.innerHTML = ""; return; }
    const st = roomStatus(state.room, state.date, state.t);
    const text = st.st === "busy" ? `Занята до ${fmt(st.until)}` : st.until ? `Свободна до ${fmt(st.until)}` : "Свободна до конца дня";
    // своя пара в этой аудитории: ближайшая не закончившаяся, иначе последняя
    const mineHere = myRooms(state.date).get(state.room) || [];
    const my = mineHere.find((e) => e.e > state.t) || mineHere[mineHere.length - 1];
    const myLine = my ? `<span class="pk-my">Ваша пара ${my.startHM}–${my.endHM} · ${esc(my.title)}</span>` : "";
    peek.innerHTML = `
      <div class="pk-main"><b>${state.room}</b><span class="status-pill ${st.st}">${text}</span>${myLine}</div>
      <button class="pk-go" data-go="list">Пары →</button>
      <button class="pk-x" title="Сбросить выбор">×</button>`;
    peek.querySelector(".pk-go").onclick = () => setView("list");
    peek.querySelector(".pk-x").onclick = () => selectRoom(null);
  }

  function renderRoomCard() {
    renderPeek();
    const box = $("roomCard");
    if (!state.room) { box.innerHTML = ""; return; }
    const room = state.room, st = roomStatus(room, state.date, state.t);
    let pill;
    if (st.st === "busy") pill = `<span class="status-pill busy">Занята до ${fmt(st.until)}</span>`;
    else if (st.until) pill = `<span class="status-pill ${st.st}">Свободна до ${fmt(st.until)}</span>`;
    else pill = `<span class="status-pill free">Свободна до конца дня</span>`;

    const span = DAY_END - DAY_START;
    const pct = (m) => ((Math.min(DAY_END, Math.max(DAY_START, m)) - DAY_START) / span) * 100;
    const blocks = (occupancy(state.date)[room] || [])
      .map((b) => `<div class="blk" style="left:${pct(b.s)}%;width:${pct(b.e) - pct(b.s)}%" title="${fmt(b.s)}–${fmt(b.e)}"></div>`).join("");
    const now = state.t >= DAY_START && state.t <= DAY_END ? `<div class="now" style="left:${pct(state.t)}%"></div>` : "";
    const wins = freeWindows(room, state.date).map(([a, b]) => `<b>${fmt(a)}–${fmt(b)}</b>`).join(", ");

    box.innerHTML = `
      <div class="room-card">
        <div class="top">
          <span class="code">${room}</span>
          <span class="where">${roomFloor[room]} этаж · ${CAMPUSES[roomCampus[room]].short}</span>
          ${pill}
          <button class="close" id="clearRoom" title="Сбросить выбор">×</button>
        </div>
        <div class="timeline">${blocks}${now}</div>
        <div class="tl-scale"><span>08</span><span>10</span><span>12</span><span>14</span><span>16</span><span>18</span><span>20</span><span>22</span></div>
        <div class="windows">Свободные окна: ${wins || "нет"}</div>
      </div>`;
    $("clearRoom").onclick = () => selectRoom(null);
  }

  function renderFree() {
    const box = $("freeBlock");
    if (state.room) { box.innerHTML = ""; return; }
    if (state.date < dataMin || state.date > dataMax) {
      box.innerHTML = `<div class="block muted">Расписание загружено на ${dayFmt.format(parseIso(dataMin))} – ${dayFmt.format(parseIso(dataMax))}. На эту дату данных нет.</div>`;
      return;
    }
    const floors = floorNums(campus).sort((a, b) => (a === state.floor ? -1 : b === state.floor ? 1 : a - b));
    let html = `<div class="block"><h3 class="block-title">Свободны в ${fmt(state.t)}</h3>`;
    let any = false;
    for (const n of floors) {
      const rooms = Object.keys(roomFloor).filter((r) => roomCampus[r] === state.campus && roomFloor[r] === n);
      if (!rooms.length) continue;
      const free = rooms
        .map((r) => ({ r, ...roomStatus(r, state.date, state.t) }))
        .filter((x) => x.st !== "busy")
        .sort((a, b) => (b.until ?? 9999) - (a.until ?? 9999) || a.r.localeCompare(b.r));
      html += `<div class="muted" style="margin:6px 0 5px">${n} этаж · ${free.length} из ${rooms.length}</div><div class="free-chips">`;
      html += free.map((x) => `<button class="free-chip ${x.st}" data-pick="${x.r}">${x.r}<small>${x.until ? "до " + fmt(x.until) : "весь день"}</small></button>`).join("");
      html += free.length ? "</div>" : `<span class="muted">всё занято</span></div>`;
      any ||= free.length > 0;
    }
    html += "</div>";
    box.innerHTML = html;
    box.querySelectorAll("[data-pick]").forEach((b) => (b.onclick = () => pickRoom(b.dataset.pick)));
  }

  function renderEvents() {
    const list = $("events");
    const q = state.query.trim().toLowerCase();
    let evs = (byDate.get(state.date) || []).filter((e) => e.campus === state.campus);
    if (state.room) evs = evs.filter((e) => e.rooms.includes(state.room));
    else if (state.scope === "floor") evs = evs.filter((e) => e.rooms.some((r) => roomFloor[r] === state.floor));
    if (q) evs = evs.filter((e) => e.search.includes(q));

    $("listTitle").textContent = state.room ? `Пары в ${state.room} · ${evs.length}` : `Пары · ${evs.length}`;
    $("scopeSeg").style.display = state.room ? "none" : "";

    if (!evs.length) {
      list.innerHTML = `<li class="empty">${state.room ? "В этот день пар в аудитории нет, она свободна" : "Пар нет"}</li>`;
      return;
    }
    const t = state.t;
    const past = evs.filter((e) => e.e <= t);
    const hidePast = !state.showPast && past.length > 0 && past.length < evs.length;
    let html = "", lineDone = false;
    if (past.length && past.length < evs.length) {
      html += `<li><button class="past-toggle" id="pastToggle">${hidePast ? "Показать" : "Скрыть"} прошедшие · ${past.length}</button></li>`;
    }
    for (const e of evs) {
      if (hidePast && e.e <= t) continue;
      if (!lineDone && e.s > t) {
        html += `<li class="now-line">${fmt(t)}</li>`;
        lineDone = true;
      }
      const cls = e.e <= t ? "past" : e.s <= t ? "now" : "";
      const kind = e.type === "Лекция" ? "lec" : /Контрольная|Экзамен|Пересдача/.test(e.type) ? "ctrl"
        : e.type === "Семинар" ? "" : "other";
      const rooms = e.rooms.map((r) => `<button class="room ${r === state.room ? "sel" : ""}" data-pick="${r}">${r}</button>`).join("");
      const meta = [e.teachers, e.stream].filter(Boolean).map(esc).join(" · ");
      html += `<li class="ev ${cls}">
        <div class="t">${e.start}<span>${e.end}</span></div>
        <div>
          <div class="title">${esc(e.title)}</div>
          <div class="meta">${rooms}<span class="kind ${kind}">${esc(e.type)}</span><span>${meta}</span></div>
        </div></li>`;
    }
    if (S.updatedAt) {
      const d = new Date(S.updatedAt);
      html += `<li class="data-stamp">Расписание от ${dayFmt.format(d)}, ${fmt(d.getHours() * 60 + d.getMinutes())} · <a href="https://cu-schedule.ru/" target="_blank" rel="noopener">cu-schedule.ru</a></li>`;
    }
    list.innerHTML = html;
    list.querySelectorAll("[data-pick]").forEach((b) => (b.onclick = () => pickRoom(b.dataset.pick)));
    const pt = $("pastToggle");
    if (pt) pt.onclick = () => { state.showPast = !state.showPast; renderEvents(); };
  }

  /* ---------- мои пары */
  const PARTSTAT = [
    ["ACCEPTED", "Приду", "yes"],
    ["TENTATIVE", "Возможно", "maybe"],
    ["DECLINED", "Не приду", "no"],
  ];
  const IC = {
    sync: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 0 1-14.3 4.9M4 12a8 8 0 0 1 14.3-4.9"/><path d="M18.5 3v4.2h-4.2M5.5 21v-4.2h4.2"/></svg>',
    video: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="m16 10.5 5-3v9l-5-3"/></svg>',
    cal: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="m9 15.5 2 2 4-4"/></svg>',
  };
  let rsvpHint = null; // { id, partstat, timer }: предложить отметить всю серию

  function loginCard() {
    return `
      <div class="login-card">
        <div class="lc-top"><span class="lc-ic lc-violet">${IC.cal}</span>
          <div class="lc-text"><b>Мои пары</b><small>Из вашего Яндекс Календаря ЦУ</small></div></div>
        <p>Только ваши пары с аудиториями на плане, ссылки на звонки и отметки «приду / не приду», как в календаре на телефоне.</p>
        <div class="form-error" id="acctError" hidden></div>
        <form id="loginForm" class="login-form" autocomplete="on">
          <label>Почта ЦУ<input name="login" type="email" inputmode="email" autocomplete="username" placeholder="i.ivanov@edu.centraluniversity.ru" required></label>
          <label>Пароль приложения<input name="password" type="password" autocomplete="current-password" placeholder="16 символов от Яндекса" required></label>
          <div class="form-error" id="loginError" hidden></div>
          <button type="submit" class="primary-btn" id="loginBtn">Войти</button>
        </form>
        <details class="howto">
          <summary>Где взять пароль приложения</summary>
          <ol>
            <li>Откройте <a href="https://id.yandex.ru/security/app-passwords" target="_blank" rel="noopener">Яндекс ID → Пароли приложений</a>, войдите через аккаунт ЦУ.</li>
            <li>Нажмите «Календарь» и назовите пароль, например «Расписание ЦУ».</li>
            <li>Скопируйте пароль, который покажет Яндекс, и вставьте сюда.</li>
          </ol>
          <p>Отозвать доступ можно там же в любой момент.</p>
        </details>
        <p class="fine">Пароль приложения открывает только календарь. На устройстве хранится зашифрованный ключ сессии, пароль в открытом виде нигде не сохраняется.</p>
      </div>`;
  }

  function syncLine() {
    if (A.syncing) return "Обновляю…";
    if (A.error) return esc(A.error);
    if (!A.fetchedAt) return "";
    const d = new Date(A.fetchedAt);
    const today = iso(d) === todayIso();
    return `Обновлено ${today ? "" : dayFmt.format(d) + ", "}в ${fmt(d.getHours() * 60 + d.getMinutes())}`;
  }

  function rsvpControl(e) {
    if (!e.partstat) return "";
    const busy = A.isPending(e.id);
    return `<div class="rsvp${busy ? " busy" : ""}" role="group" aria-label="Присутствие">${PARTSTAT.map(([v, label, cls]) =>
      `<button class="${cls}${e.partstat === v ? " on" : ""}" data-ps="${v}" aria-pressed="${e.partstat === v}"${busy ? " disabled" : ""}>${label}</button>`).join("")}</div>`;
  }

  function mineItem(e, t, isToday) {
    const cls = isToday && e.e <= t ? "past" : isToday && e.s <= t ? "now" : "";
    let place;
    if (e.online) place = `<span class="online-tag">Онлайн</span>`;
    else if (e.rooms.length) {
      place = e.rooms.map((r) => roomFloor[r]
        ? `<button class="room ${r === state.room ? "sel" : ""}" data-pick="${r}" title="Показать на плане">${r}</button>`
        : `<span class="room off">${esc(r)}</span>`).join("");
      if (e.campus === "DUCAT") place += `<span class="campus-tag">Дукат</span>`;
      else if (e.campus === "OTHER") place += `<span class="campus-tag">${esc(e.campusName || "")}</span>`;
    } else place = e.location ? `<span>${esc(e.location)}</span>` : "";
    const kind = e.type === "Лекция" ? "lec" : /Контрольная|Экзамен|Пересдача/.test(e.type) ? "ctrl" : e.type === "Семинар" ? "" : "other";
    const meta = [e.teachers, e.timetable ? "" : e.calendar].filter(Boolean).map(esc).join(" · ");
    const join = e.url ? `<a class="join${e.online ? " primary" : ""}" href="${esc(e.url)}" target="_blank" rel="noopener">${IC.video}${e.online ? "Подключиться" : "Звонок"}</a>` : "";
    const hint = rsvpHint && rsvpHint.id === e.id
      ? `<div class="rsvp-hint">Отмечено для этого занятия. <button data-series="${rsvpHint.partstat}">Отметить всю серию</button></div>` : "";
    const time = e.allDay ? `<div class="t">весь<span>день</span></div>` : `<div class="t">${e.startHM}<span>${e.endHM}</span></div>`;
    return `<li class="ev my ${cls}${e.partstat === "DECLINED" ? " declined" : ""}" data-id="${esc(e.id)}">
      ${time}
      <div>
        <div class="title">${esc(e.title)}</div>
        <div class="meta">${place}${e.type ? `<span class="kind ${kind}">${esc(e.type)}</span>` : ""}${meta ? `<span>${meta}</span>` : ""}</div>
        ${join || e.partstat ? `<div class="ev-actions">${join}${rsvpControl(e)}</div>` : ""}
        ${hint}
      </div></li>`;
  }

  function renderMine() {
    const box = $("mine");
    if (!A.user) {
      // форму не перерисовываем: иначе пропадёт уже введённое
      if (!box.querySelector("#loginForm")) box.innerHTML = loginCard();
      const err = $("acctError");
      err.textContent = A.error || "";
      err.hidden = !A.error;
      return;
    }
    A.ensure(state.date);
    const evs = myEvents(state.date);
    const loading = !A.covers(state.date);
    const isToday = state.date === todayIso(), t = state.t;
    let html = `<div class="list-head"><h2>Мои пары${loading ? "" : " · " + evs.length}</h2>
      <button class="icon-btn sync-btn${A.syncing ? " spin" : ""}" id="syncBtn" title="Обновить из календаря">${IC.sync}</button></div>
      <div class="sync-state${A.error ? " err" : ""}">${syncLine()}</div><ol class="events">`;
    if (loading) html += `<li class="empty">Загружаю расписание на эту дату…</li>`;
    else if (!evs.length) html += `<li class="empty">В этот день пар нет</li>`;
    let lineDone = !isToday;
    for (const e of evs) {
      if (!lineDone && e.s > t) { html += `<li class="now-line">${fmt(t)}</li>`; lineDone = true; }
      html += mineItem(e, t, isToday);
    }
    html += `</ol><div class="account-line"><span>${esc(A.user.name || A.user.email)}</span><button id="logoutBtn">Выйти</button></div>`;
    box.innerHTML = html;
  }

  function toast(text) {
    const el = $("toast");
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, 4200);
  }

  async function mark(ev, partstat, scope) {
    try {
      await A.rsvp(ev, partstat, scope);
      if (tgAt("6.1")) tg.HapticFeedback.notificationOccurred("success");
      if (scope === "series") toast("Отмечено для всех будущих занятий серии");
    } catch (e) {
      if (tgAt("6.1")) tg.HapticFeedback.notificationOccurred("error");
      toast(e.code === "forbidden" ? "Яндекс не разрешил изменить это событие" : `Не удалось отметить: ${e.message}`);
    }
  }

  $("mine").addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    const li = t.closest("[data-id]");
    const ev = li && myEvents(state.date).find((x) => x.id === li.dataset.id);
    if (t.dataset.pick) {
      pickRoom(t.dataset.pick);
    } else if (t.dataset.ps && ev) {
      const v = t.dataset.ps;
      if (ev.partstat === v) return;
      clearTimeout(rsvpHint && rsvpHint.timer);
      rsvpHint = ev.recurring ? { id: ev.id, partstat: v, timer: setTimeout(() => { rsvpHint = null; renderMine(); }, 12000) } : null;
      mark(ev, v, "one");
    } else if (t.dataset.series && ev) {
      clearTimeout(rsvpHint.timer);
      rsvpHint = null;
      mark(ev, t.dataset.series, "series");
    } else if (t.id === "syncBtn") {
      A.sync({ force: true });
    } else if (t.id === "logoutBtn") {
      A.logout();
      toast("Вы вышли. Пароль приложения можно отозвать в Яндекс ID");
    }
  });

  $("mine").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector("#loginBtn"), err = f.querySelector("#loginError");
    btn.disabled = true; btn.textContent = "Проверяю…"; err.hidden = true;
    try {
      await A.loginWithPassword(f.login.value, f.password.value);
      if (tgAt("6.1")) tg.HapticFeedback.notificationOccurred("success");
    } catch (x) {
      err.textContent = x.code === "auth" ? "Яндекс не принял почту или пароль. Нужен именно пароль приложения для календаря." : x.message;
      err.hidden = false;
      btn.disabled = false; btn.textContent = "Войти";
    }
  });

  function renderMode() {
    $("modeBar").hidden = !A.enabled;
    $("modeSeg").querySelectorAll("button").forEach((b) => b.classList.toggle("on", (b.dataset.mode === "mine") === state.mine));
    $("mine").hidden = !state.mine;
    $("allPart").hidden = state.mine;
  }
  function setMode(mine) {
    state.mine = mine;
    try { localStorage.setItem("cu.mode", mine ? "mine" : "all"); } catch (e) { /* приватный режим */ }
    renderSide();
  }
  $("modeSeg").addEventListener("click", (e) => {
    const b = e.target.closest("[data-mode]");
    if (b) setMode(b.dataset.mode === "mine");
  });

  A.onChange((why) => {
    if (why === "login") state.mine = true;
    renderFloorSeg(); paintRooms(); renderSide();
  });

  function renderSide() {
    renderHead(); renderMode(); renderRoomCard();
    if (state.mine) renderMine(); else { renderFree(); renderEvents(); }
  }
  function renderAll() { renderFloorSeg(); paintRooms(); renderSide(); writeHash(); syncTgBackButton(); }

  /* ============================================================ Действия */
  function setFloor(n) {
    if (n === state.floor) return;
    state.floor = n;
    state.zoom = 1; state.pan = [0, 0];
    buildPlan();
    renderAll();
  }
  /* ---------- вкладки мобильной версии */
  const VIEWS = ["plan", "list", "info"];
  function setView(v, { silent } = {}) {
    if (!VIEWS.includes(v)) return;
    const changed = v !== state.view;
    state.view = v;
    $("app").dataset.view = v;
    $("tabbar").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
    const lens = $("tabLens");
    lens.style.transform = `translateX(${VIEWS.indexOf(v) * 100}%)`;
    if (changed && !silent) {
      lens.classList.remove("stretch"); void lens.offsetWidth; lens.classList.add("stretch");
      if (tgAt("6.1")) tg.HapticFeedback.selectionChanged();
      $("sideBody").scrollTop = 0;
    }
    writeHash();
    syncTgBackButton();
  }
  $("tabbar").addEventListener("click", (e) => {
    const b = e.target.closest("[data-view]");
    if (b) setView(b.dataset.view);
  });

  const lastFloor = {};
  function setCampus(id) {
    if (id === state.campus || !CAMPUSES[id]) return;
    lastFloor[state.campus] = state.floor;
    state.campus = id; campus = CAMPUSES[id];
    state.room = null;
    state.floor = lastFloor[id] || defaultFloor(campus);
    state.zoom = 1; state.pan = [0, 0];
    updateCenter();
    buildPlan();
    renderAll();
  }
  // Аудитория из списка: выбрать, на телефоне открыть план, приблизить
  function pickRoom(room) {
    selectRoom(room);
    if (isPhone()) setView("plan");
    focusRoom(room);
  }
  function selectRoom(room) {
    if (room && roomCampus[room] !== state.campus) {
      state.campus = roomCampus[room]; campus = CAMPUSES[state.campus]; updateCenter();
      state.floor = -1;
    }
    if (room && room !== state.room && tgAt("6.1")) tg.HapticFeedback.selectionChanged();
    state.room = room;
    if (room && roomFloor[room] !== state.floor) { state.floor = roomFloor[room]; buildPlan(); }
    hideTip();
    renderAll();
  }
  function setDate(d) {
    state.date = d;
    // сегодня показываем по живому времени, другой день с утра
    state.live = d === todayIso();
    state.t = state.live ? nowMin() : OTHER_DAY_T;
    renderAll();
  }

  /* ---------- свайп по датам на телефоне: влево - следующий день, вправо - предыдущий */
  const SWIPE_MIN = 56;
  let swipedAt = 0;
  function swipeDays(zone, targets) {
    let s = null;
    const move = (dx, anim) => {
      for (const t of targets()) {
        t.style.transition = anim ? "transform .28s cubic-bezier(.2, .8, .3, 1), opacity .28s" : "none";
        t.style.transform = dx ? `translateX(${dx}px)` : "";
        t.style.opacity = dx ? String(1 - Math.min(0.6, Math.abs(dx) / 260)) : "";
      }
    };
    zone.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" || !isPhone() || !targets() || e.target.closest("input[type=range], input[type=search]")) return;
      s = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, on: false };
    });
    zone.addEventListener("pointermove", (e) => {
      if (!s || e.pointerId !== s.id) return;
      const dx = e.clientX - s.x, dy = e.clientY - s.y;
      if (!s.on) {
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { s = null; return; } // это вертикальный скролл
        if (Math.abs(dx) < 10) return;
        s.on = true;
        zone.setPointerCapture(e.pointerId);
      }
      s.dx = dx;
      move(dx * 0.6);
    });
    const end = (e) => {
      if (!s || e.pointerId !== s.id) return;
      const { on, dx } = s;
      s = null;
      if (!on) return;
      swipedAt = performance.now();
      if (e.type !== "pointerup" || Math.abs(dx) < SWIPE_MIN) return move(0, true);
      const dir = dx < 0 ? 1 : -1;
      setDate(addDays(state.date, dir));
      if (tgAt("6.1")) tg.HapticFeedback.selectionChanged();
      // новый день въезжает с той стороны, куда тянули
      move(dir * 70);
      void zone.offsetWidth;
      move(0, true);
    };
    zone.addEventListener("pointerup", end);
    zone.addEventListener("pointercancel", end);
  }
  // после свайпа палец отпускают над кнопкой: этот клик не нужен
  document.addEventListener("click", (e) => {
    if (performance.now() - swipedAt < 350) { e.stopPropagation(); e.preventDefault(); }
  }, true);
  const dateRow = document.querySelector(".date-row");
  swipeDays(dateRow, () => [dateRow]);
  swipeDays($("sideBody"), () => (state.view === "list" ? [dateRow, document.querySelector(".sched-part")] : null));

  $("campusSeg").addEventListener("click", (e) => {
    const b = e.target.closest("[data-campus]");
    if (b) setCampus(b.dataset.campus);
  });
  $("prevDay").onclick = () => setDate(addDays(state.date, -1));
  $("nextDay").onclick = () => setDate(addDays(state.date, 1));
  $("datePick").onchange = (e) => e.target.value && setDate(e.target.value);
  $("timeRange").oninput = (e) => {
    state.t = +e.target.value; state.live = false;
    paintRooms(); renderSide(); writeHash();
  };
  $("nowBtn").onclick = () => {
    state.live = true; state.date = todayIso(); state.t = nowMin();
    renderAll();
  };
  $("scopeSeg").addEventListener("click", (e) => {
    const b = e.target.closest("[data-scope]");
    if (!b) return;
    state.scope = b.dataset.scope;
    $("scopeSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    renderEvents();
  });
  $("search").oninput = (e) => { state.query = e.target.value; renderEvents(); };

  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") { if (e.key === "Escape") e.target.blur(); return; }
    if (e.key === "Escape") selectRoom(null);
    else if (e.key === "ArrowLeft") setDate(addDays(state.date, -1));
    else if (e.key === "ArrowRight") setDate(addDays(state.date, 1));
    else if (/^[0-9]$/.test(e.key) && campus.floors[e.key === "0" ? 10 : +e.key]) setFloor(e.key === "0" ? 10 : +e.key);
    else if (e.key === "r" || e.key === "к") rotateTo(state.angle + 90);
  });

  // Живое время
  setInterval(() => {
    if (!state.live) return;
    const m = nowMin();
    if (m !== state.t) {
      state.t = m;
      if (state.date !== todayIso()) state.date = todayIso();
      paintRooms(); renderSide();
    }
  }, 20000);

  window.addEventListener("resize", applyTransform);

  // Тема: как в системе -> светлая -> тёмная
  const THEMES = { auto: "как в системе", light: "светлая", dark: "тёмная" };
  function applyTheme(mode) {
    const root = document.documentElement;
    // «как в системе» внутри Telegram = тема Telegram, а не ОС
    if (mode === "auto") {
      if (inTg) root.dataset.theme = tg.colorScheme === "dark" ? "dark" : "light";
      else delete root.dataset.theme;
    } else root.dataset.theme = mode;
    $("themeBtn").dataset.mode = mode;
    $("themeBtn").title = `Тема: ${THEMES[mode]}`;
    try { mode === "auto" ? localStorage.removeItem("theme") : localStorage.setItem("theme", mode); } catch (e) { /* приватный режим */ }
    syncTgColors();
  }
  let storedTheme = "auto";
  try { storedTheme = localStorage.getItem("theme") || "auto"; } catch (e) { /* приватный режим */ }
  applyTheme(THEMES[storedTheme] ? storedTheme : "auto");
  if (inTg) tg.onEvent("themeChanged", () => { if ($("themeBtn").dataset.mode === "auto") applyTheme("auto"); });
  $("themeBtn").onclick = () => {
    const order = ["auto", "light", "dark"];
    applyTheme(order[(order.indexOf($("themeBtn").dataset.mode) + 1) % 3]);
  };

  initTelegram();
  buildPlan();
  setView(state.view, { silent: true });
  renderAll();
  // сразу показываем сохранённое, затем сверяемся с календарём
  if (A.user) A.sync();
})();
