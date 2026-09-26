/* Действия пользователя: меняют состояние и двигают план */
import { CAMPUSES, defaultFloor, roomCampus, roomFloor, type CampusId } from "./schedule";
import { getState, setRoute, setState, emptyRoute, type Field, type View } from "./store";
import { haptic } from "./telegram";
import { isPhone, lsGet, lsSet, nowMin, OTHER_DAY_T, todayIso } from "./util";
import { canStand, inPoly, plan as planRoute } from "../nav/engine";
import { getPlace, mainEntrance, NEAREST, pointKey, type Place } from "../nav/places";
import { cityStep, stepsOf, type Option } from "../nav/steps";
import { ADDRESS, cityLegs } from "../nav/city";
import type { GoalPoint, RouteOption } from "../nav/engine";
import type { Pt } from "../types";

/* ---------- связь с планом: методы регистрирует PlanView */
export interface Box { x: number; y: number; width: number; height: number }
export interface FocusOpts { fill?: number; minZoom?: number; maxZoom?: number; bottom?: number | null; square?: boolean }
export interface PlanControl {
  focusRoom(id: string): void;
  focusBox(b: Box, o?: FocusOpts): void;
  rotateTo(angle: number): void;
  turn(angle: number): void;   // поворот рукой без анимации, вокруг центра экрана
  settle(): void;              // конец поворота рукой: доводка к прямому углу и сохранение
  zoomBy(k: number): void;
  setInset(px: number): void; // сколько пикселей снизу закрыто панелью: план поднимается над ней
}
export const planCtl: { current: PlanControl | null } = { current: null };
// После смены состояния React перерисовывает экран в следующем кадре: камеру двигаем после него
const afterPaint = (fn: () => void) => requestAnimationFrame(() => requestAnimationFrame(fn));

export const bboxOf = (pts: Pt[]): Box => {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
};

/* ---------- сообщения */
let toastId = 0, toastTimer = 0;
export function toast(text: string) {
  setState({ toast: { text, id: ++toastId } });
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => setState({ toast: null }), 4200);
}

/* ---------- план: кампус, этаж, аудитория */
const lastFloor: Record<string, number> = {};

export function setFloor(n: number) {
  if (n === getState().floor) return;
  setState({ floor: n });
}

export function setCampus(id: CampusId) {
  const s = getState();
  if (id === s.campus || !CAMPUSES[id]) return;
  lastFloor[s.campus] = s.floor;
  setState({ campus: id, room: null, roomScreen: false, floor: lastFloor[id] || defaultFloor(CAMPUSES[id]) });
}

export function selectRoom(room: string | null) {
  const s = getState();
  if (room && room !== s.room) haptic.select();
  const patch: Parameters<typeof setState>[0] = { room, roomScreen: room ? s.roomScreen && room === s.room : false };
  if (room) { patch.campus = roomCampus[room]; patch.floor = roomFloor[room]; }
  setState(patch);
}

// Аудитория из списка: выбрать, открыть план, приблизить
export function pickRoom(room: string) {
  selectRoom(room);
  setState({ roomScreen: false });
  if (isPhone()) setView("plan");
  afterPaint(() => planCtl.current?.focusRoom(room));
}

export const openRoomScreen = () => { if (getState().room) setState({ roomScreen: true }); };
export const closeRoomScreen = () => setState({ roomScreen: false });
export const openFreeScreen = () => setState({ freeScreen: true });
export const closeFreeScreen = () => setState({ freeScreen: false });

export const openGuide = (slide = 0) => { haptic.select(); setState({ guide: slide }); };
export const closeGuide = () => setState({ guide: null });

export function setView(v: View) {
  if (v === getState().view) return;
  haptic.select();
  setState({ view: v });
}

/* ---------- дата и время */
export function setDate(d: string) {
  // сегодня показываем по живому времени, другой день с утра
  const live = d === todayIso();
  setState({ date: d, live, t: live ? nowMin() : OTHER_DAY_T });
}
export const setTime = (t: number) => setState({ t, live: false });
export const goNow = () => setState({ live: true, date: todayIso(), t: nowMin() });
export const tick = () => {
  const s = getState();
  if (!s.live) return;
  const m = nowMin();
  if (m !== s.t) setState({ t: m, date: todayIso() });
};

export function setMode(mine: boolean) {
  lsSet("cu.mode", mine ? "mine" : "all");
  setState({ mine });
}

/* ============================================================ Маршруты */
const isPoint = (k: string | null) => { const p = getPlace(k); return !p || p.kind === "point"; };

export function openRoute({ from, to }: { from?: string | null; to?: string | null } = {}) {
  const r = getState().route;
  let nf = from || r.from, nt = to || r.to;
  // Точка, указанная на плане, разовая: в следующий раз не подставляем
  if (!to && nt && isPoint(nt)) nt = null;
  const cid = getPlace(nt)?.campus || getPlace(nf)?.campus || getState().campus;
  // откуда: прошлая точка старта в этом кампусе, иначе главный вход
  if (!from && (!nf || isPoint(nf) || getPlace(nf)!.campus !== cid || nf === nt)) {
    const saved = getPlace(lsGet("cu.routeFrom"));
    nf = saved && saved.kind !== "point" && saved.campus === cid && saved.key !== nt ? saved.key : mainEntrance(cid)?.key || null;
  }
  if (nt === nf) nt = null;
  setState({ route: { ...emptyRoute, open: true, from: nf, to: nt } });
  computeRoute();
}

export function closeRoute() {
  routeJob++;
  setState((s) => ({ route: { ...emptyRoute, from: s.route.from, to: s.route.to } }));
}

// «Назад»: выбор точки на плане -> шаги -> выбор маршрута -> закрыть
export function routeBack() {
  const r = getState().route;
  if (r.picking) setRoute({ picking: null });
  else if (r.step >= 0) { setRoute({ step: -1 }); focusOption(); }
  else closeRoute();
}

export function setRoutePlace(field: Field, key: string | null) {
  setRoute({ [field]: key, picking: null });
  const p = getPlace(key);
  if (field === "from" && p && p.kind !== "nearest" && p.kind !== "point") lsSet("cu.routeFrom", p.key);
  computeRoute();
}

export function swapRoute() {
  const r = getState().route;
  if (getPlace(r.to)?.kind === "nearest") return toast("«Ближайшее» можно выбрать только как цель");
  setRoute({ from: r.to, to: r.from });
  computeRoute();
}

let routeJob = 0;
export function computeRoute() {
  const r = getState().route;
  setRoute({ options: null, error: null, sel: 0, step: -1, busy: false });
  const a = getPlace(r.from), b = getPlace(r.to);
  if (!a || !b || !a.campus) return;
  const cross = b.kind !== "nearest" && b.campus !== a.campus;
  if (cross && (!ADDRESS[a.campus] || !ADDRESS[b.campus!])) {
    setRoute({ error: "Для этого кампуса пока не знаю дорогу по городу" });
    return;
  }
  setRoute({ busy: true });
  const job = ++routeJob;
  // первый маршрут на этаже строит сетку, это заметная доля секунды: даём отрисоваться «Строю…»
  setTimeout(() => {
    if (job !== routeJob) return;
    const cid = a.campus!;
    if (cross) {
      const res = crossRoute(a, b);
      if (typeof res === "string") setRoute({ busy: false, error: res });
      else { setRoute({ busy: false, campus: cid, options: res }); focusOption(); }
      return;
    }
    const to = b.kind === "nearest" ? { points: NEAREST[b.key].points(cid) } : { floor: b.floor!, x: b.x!, y: b.y! };
    let res;
    try { res = planRoute(cid, { floor: a.floor!, x: a.x!, y: a.y! }, to); }
    catch (e) { console.error(e); res = { error: "Не получилось проложить маршрут" }; }
    if (res.error || !res.options) { setRoute({ busy: false, error: res.error || "Не получилось проложить маршрут" }); return; }
    setRoute({ busy: false, campus: cid, options: res.options.map((o) => ({ ...o, steps: stepsOf(o, b) })) });
    focusOption();
  }, 30);
}

const at = (p: Place): GoalPoint => ({ floor: p.floor!, x: p.x!, y: p.y! });

// Между кампусами: до выхода в первом здании, по городу, от входа до цели во втором.
// Внутри зданий берём рекомендуемый путь, варианты - способы добраться по городу.
function crossRoute(a: Place, b: Place): Option[] | string {
  const exit = getPlace(ADDRESS[a.campus!].entrance)!, door = getPlace(ADDRESS[b.campus!].entrance)!;
  const inside = (p: Place, q: Place): RouteOption | string | null => {
    if (p.key === q.key) return null; // уже у входа
    try {
      const res = planRoute(p.campus!, at(p), at(q));
      return res.options ? res.options[0] : res.error!;
    } catch (e) { console.error(e); return "Не получилось проложить маршрут"; }
  };
  const A = inside(a, exit), B = inside(door, b);
  if (typeof A === "string") return A;
  if (typeof B === "string") return B;
  const tag = <T extends object>(legs: T[], campus: string) => legs.map((l) => ({ ...l, campus }));
  const legsA = A ? tag(A.legs, a.campus!) : [], legsB = B ? tag(B.legs, b.campus!) : [];
  const stepsA = A ? stepsOf({ ...A, legs: legsA }, exit).map((s) => ({ ...s, campus: a.campus })) : [];
  const stepsB = B ? stepsOf({ ...B, legs: legsB }, b).map((s) => ({ ...s, campus: b.campus })) : [];
  // первый шаг во втором здании: иначе «1 этаж» непонятно где
  if (stepsB[0]) stepsB[0] = { ...stepsB[0], text: `${CAMPUSES[b.campus!].short}: ${stepsB[0].text[0].toLowerCase()}${stepsB[0].text.slice(1)}` };
  return cityLegs(a.campus!, b.campus!).map((c) => ({
    profile: "city:" + c.mode, city: c,
    legs: [...legsA, c, ...legsB],
    goal: B ? B.goal : at(b),
    walk: (A?.walk || 0) + c.walk + (B?.walk || 0),
    time: (A?.time || 0) + c.time + (B?.time || 0),
    kinds: [...new Set([...(A?.kinds || []), ...(B?.kinds || [])])],
    steps: [...stepsA, cityStep(c, exit.floor!), ...stepsB],
  }));
}

const curOption = () => { const r = getState().route; return r.options ? r.options[r.sel] : null; };

// Переключить кампус и этаж под маршрут, не сбрасывая его
function showFloor(cid: CampusId, n: number) {
  const s = getState();
  if (cid !== s.campus) { lastFloor[s.campus] = s.floor; setState({ campus: cid, room: null, roomScreen: false, floor: n }); }
  else if (n !== s.floor) setState({ floor: n });
}

// Выбор маршрута: этаж старта и первый отрезок целиком
export function focusOption() {
  const o = curOption(), cid = getState().route.campus;
  if (!o || !cid) return;
  const first = o.steps[0];
  showFloor(first.campus || cid, first.leg.type === "ride" ? first.leg.from : first.floor);
  afterPaint(() => {
    const s = getState();
    const leg = o.legs.find((l) => l.type === "walk" && l.floor === s.floor && (l.campus || cid) === s.campus);
    if (leg && leg.type === "walk") planCtl.current?.focusBox(bboxOf(leg.pts), { fill: 0.8, square: false, minZoom: 1, maxZoom: 3 });
  });
}

export function selectOption(i: number) {
  if (i === getState().route.sel) return;
  setRoute({ sel: i, step: -1 });
  focusOption();
}

// Сколько пикселей плана снизу закрывает карточка шага
function sheetCover() {
  const sh = document.getElementById("routeSheet"), svg = document.getElementById("plan");
  if (!sh || !svg) return null;
  return Math.max(0, svg.getBoundingClientRect().bottom - sh.getBoundingClientRect().top + 12);
}

export function goStep(i: number) {
  const o = curOption(), cid = getState().route.campus;
  if (!o || !cid) return;
  const step = Math.max(0, Math.min(o.steps.length - 1, i));
  const s = o.steps[step];
  setRoute({ step });
  showFloor(s.campus || cid, s.floor);
  haptic.select();
  afterPaint(() => {
    const bottom = sheetCover();
    if (s.leg.type === "city") {
      // по городу: показываем вход, через который выходим
      const e = getPlace(ADDRESS[s.leg.from].entrance)!;
      planCtl.current?.focusBox({ x: e.x! - 120, y: e.y! - 120, width: 240, height: 240 }, { fill: 0.5, minZoom: 1.5, maxZoom: 3, bottom });
    } else if (s.leg.type === "walk") planCtl.current?.focusBox(bboxOf(s.leg.pts), { fill: 0.78, square: false, minZoom: 1.2, maxZoom: 3.5, bottom });
    else {
      const [x, y] = s.leg.at;
      planCtl.current?.focusBox({ x: x - 90, y: y - 90, width: 180, height: 180 }, { fill: 0.5, minZoom: 2, maxZoom: 3.5, bottom });
    }
  });
}

export function finishRoute() {
  haptic.ok();
  closeRoute();
}

/* ---------- точка на плане */
export function startPick(field: Field) {
  const r = getState().route;
  setRoute({ picking: field });
  // план того кампуса, где вторая точка маршрута
  const other = getPlace(field === "from" ? r.to : r.from);
  if (other?.campus && other.campus !== getState().campus) showFloor(other.campus, other.floor!);
  (document.activeElement as HTMLElement | null)?.blur?.();
}

// Нажатие на план в режиме выбора точки: помещение целиком или точка в коридоре
export function pickPoint(x: number, y: number) {
  const s = getState(), field = s.route.picking;
  if (!field) return;
  const floor = CAMPUSES[s.campus].floors[s.floor];
  const r = floor.rooms.find((r) => r.pts.length > 2 && inPoly(x, y, r.pts));
  let key = r && getPlace("r:" + r.id) ? "r:" + r.id : null;
  if (!key) {
    if (!canStand(s.campus, s.floor, x, y)) { toast("Сюда не пройти: выберите место внутри здания"); return; }
    key = pointKey(s.campus, s.floor, x, y);
  }
  haptic.select();
  setRoutePlace(field, key);
}

// Нажатие на аудиторию, пока выбирают маршрут: заполняет «куда», а если оно есть - «откуда»
export const tapRoomInRoute = (room: string) => setRoutePlace(getState().route.to ? "from" : "to", "r:" + room);
