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

  /* ============================================================ Даты */
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseIso = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parseIso(s); d.setDate(d.getDate() + n); return iso(d); };
  const todayIso = () => iso(new Date());
  const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
  const dowFmt = new Intl.DateTimeFormat("ru-RU", { weekday: "long" });
  const dayFmt = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });

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
  };

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
  })();

  function writeHash() {
    const h = new URLSearchParams();
    if (state.campus !== "CT") h.set("c", state.campus);
    h.set("f", state.floor);
    if (state.date !== todayIso()) h.set("d", state.date);
    if (!state.live) h.set("t", fmt(state.t));
    if (state.room) h.set("r", state.room);
    if (state.angle) h.set("rot", ((state.angle % 360) + 360) % 360);
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
        const tg = tag(g, r.label, { size: 13, cls: k });
        if (r.vertical) tg.setAttribute("transform", "rotate(-90)");
        tg.style.pointerEvents = "none";
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
        const tg = tag(g, text, { size: 11, cls: isCowork(r) ? "tag-open" : TAG_CLS[r.color] || "", padX: 6 });
        el("title", {}, tg).textContent = r.label ? `${r.id}: ${r.label}` : r.id;
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
    const a = state.angle % 360;
    rotateTo(state.angle - (a > 180 ? a - 360 : a < -180 ? a + 360 : a));
  };

  function svgPoint(clientX, clientY) {
    const p = svg.createSVGPoint();
    p.x = clientX; p.y = clientY;
    return p.matrixTransform(svg.getScreenCTM().inverse());
  }
  function zoomAt(factor, clientX, clientY) {
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
  $("zoomIn").onclick = () => zoomAt(1.4);
  $("zoomOut").onclick = () => zoomAt(1 / 1.4);
  svg.addEventListener("wheel", (e) => { e.preventDefault(); zoomAt(Math.exp(-e.deltaY * 0.0022), e.clientX, e.clientY); }, { passive: false });

  // Перетаскивание (клик отличаем от драга по сдвигу)
  let drag = null;
  const pointers = new Map();
  svg.addEventListener("pointerdown", (e) => {
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
  svg.addEventListener("pointerover", (e) => {
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
    for (const [room, poly] of Object.entries(roomEls)) {
      const st = roomStatus(room, state.date, state.t);
      poly.classList.remove("free", "soon", "busy");
      poly.classList.add(st.st);
      poly.classList.toggle("sel", room === state.room);
      const lab = roomLabelEls[room];
      lab.dot.setAttribute("class", "dot dot-" + st.st);
      lab.sub.setAttribute("class", "sub dot-" + st.st);
      lab.sub.textContent = st.st === "busy" ? `до ${fmt(st.until)}` : st.until ? `своб. до ${fmt(st.until)}` : "свободна";
    }
    svg.querySelectorAll(".rooms").forEach((g) => g.classList.toggle("has-sel", !!state.room));
  }

  /* ============================================================ Правая колонка */
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function renderFloorSeg() {
    const seg = $("floorSeg");
    seg.innerHTML = "";
    seg.classList.toggle("many", floorNums(campus).length > 4);
    for (const n of floorNums(campus)) {
      const b = document.createElement("button");
      b.innerHTML = `${n}<span class="fl-w"> этаж</span>`;
      b.title = `${n} этаж`;
      b.className = +n === state.floor ? "on" : "";
      b.onclick = () => setFloor(+n);
      seg.appendChild(b);
    }
    const f = campus.floors[state.floor];
    $("floorN").textContent = `Этаж ${state.floor}`;
    $("floorSum").textContent = f.summary || autoSummary(f);
    $("campusSeg").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.campus === state.campus));
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

  function renderRoomCard() {
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
          <div><div class="code">${room}</div><div class="where">Аудитория · ${roomFloor[room]} этаж · ${CAMPUSES[roomCampus[room]].short}</div></div>
          <button class="close" id="clearRoom" title="Сбросить выбор">×</button>
        </div>
        ${pill}
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
    box.querySelectorAll("[data-pick]").forEach((b) => (b.onclick = () => selectRoom(b.dataset.pick)));
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
      const kind = e.type === "Лекция" ? "lec" : /Контрольная|Экзамен|Пересдача/.test(e.type) ? "ctrl" : "";
      const rooms = e.rooms.map((r) => `<button class="room ${r === state.room ? "sel" : ""}" data-pick="${r}">${r}</button>`).join("");
      const meta = [e.teachers, e.stream].filter(Boolean).map(esc).join(" · ");
      html += `<li class="ev ${cls}">
        <div class="t">${e.start}<span>${e.end}</span></div>
        <div>
          <div class="title">${esc(e.title)}</div>
          <div class="meta">${rooms}<span class="kind ${kind}">${esc(e.type)}</span><span>${meta}</span></div>
        </div></li>`;
    }
    list.innerHTML = html;
    list.querySelectorAll("[data-pick]").forEach((b) => (b.onclick = () => selectRoom(b.dataset.pick)));
    const pt = $("pastToggle");
    if (pt) pt.onclick = () => { state.showPast = !state.showPast; renderEvents(); };
  }

  function renderSide() { renderHead(); renderRoomCard(); renderFree(); renderEvents(); }
  function renderAll() { renderFloorSeg(); paintRooms(); renderSide(); writeHash(); }

  /* ============================================================ Действия */
  function setFloor(n) {
    if (n === state.floor) return;
    state.floor = n;
    state.zoom = 1; state.pan = [0, 0];
    buildPlan();
    renderAll();
  }
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
  function selectRoom(room) {
    if (room && roomCampus[room] !== state.campus) {
      state.campus = roomCampus[room]; campus = CAMPUSES[state.campus]; updateCenter();
      state.floor = -1;
    }
    state.room = room;
    if (room && roomFloor[room] !== state.floor) { state.floor = roomFloor[room]; buildPlan(); }
    hideTip();
    renderAll();
  }
  function setDate(d) {
    state.date = d;
    if (d !== todayIso() && state.live) state.live = false;
    renderAll();
  }

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

  buildPlan();
  renderAll();
})();
