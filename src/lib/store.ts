/* Состояние приложения: один объект, неизменяемые обновления, подписка для React и плана */
import { useSyncExternalStore } from "react";
import { CAMPUSES, defaultFloor, roomCampus, roomFloor, type CampusId } from "./schedule";
import { fmt, lsGet, nowMin, OTHER_DAY_T, toMin, todayIso } from "./util";
import { account } from "./account";
import { getPlace } from "../nav/places";
import type { Option } from "../nav/steps";

export type View = "plan" | "list" | "profile";
export type Field = "from" | "to";

export interface RouteState {
  open: boolean;
  from: string | null;
  to: string | null;
  busy: boolean;
  error: string | null;
  options: Option[] | null;
  campus: CampusId | null;   // кампус, для которого построены варианты
  sel: number;               // выбранный вариант
  step: number;              // -1 - выбор маршрута, 0.. - пошаговый режим
  picking: Field | null;     // для какого поля указывают точку на плане
}

export interface AppState {
  campus: CampusId;
  floor: number;
  date: string;
  t: number;
  live: boolean;
  room: string | null;       // выбранная на плане аудитория
  roomScreen: boolean;       // телефон: расписание выбранной аудитории на весь экран
  freeScreen: boolean;       // вкладка «Расписание»: экран свободных аудиторий вместо списка пар
  angle: number;             // поворот плана, градусы (любой, кнопки крутят на 90)
  view: View;                // вкладка мобильной версии
  mine: boolean;             // список: мои пары или все
  query: string;
  showPast: boolean;
  route: RouteState;
  toast: { text: string; id: number } | null;
  guide: number | null;      // инструкция подключения календаря: открытый слайд или null
}

export const emptyRoute: RouteState = {
  open: false, from: null, to: null, busy: false, error: null, options: null, campus: null, sel: 0, step: -1, picking: null,
};

function initialState(): AppState {
  const s: AppState = {
    campus: "CT", floor: 3, date: todayIso(), t: nowMin(), live: true,
    room: null, roomScreen: false, freeScreen: false, angle: 0, view: "plan",
    mine: account.enabled && (lsGet("cu.mode") ? lsGet("cu.mode") === "mine" : !!account.user),
    query: "", showPast: false, route: emptyRoute, toast: null, guide: null,
  };
  const h = new URLSearchParams(location.hash.slice(1));
  const c = h.get("c");
  if (c && CAMPUSES[c]) { s.campus = c; s.floor = defaultFloor(CAMPUSES[c]); }
  const f = h.get("f");
  if (f && CAMPUSES[s.campus].floors[f]) s.floor = +f;
  const d = h.get("d");
  if (d && /^\d{4}-\d\d-\d\d$/.test(d)) s.date = d;
  const r = h.get("r");
  if (r && roomFloor[r]) {
    s.room = r;
    s.campus = roomCampus[r];
    s.floor = roomFloor[r];
    s.roomScreen = h.get("v") === "room";
  }
  const rot = h.get("rot");
  if (rot) s.angle = ((+rot % 360) + 360) % 360;
  const t = h.get("t");
  if (t && /^\d\d:\d\d$/.test(t)) { s.t = toMin(t); s.live = false; }
  else if (s.date !== todayIso()) { s.t = OTHER_DAY_T; s.live = false; }
  const v = h.get("v");
  if (v === "list" || v === "profile") s.view = v;
  if (v === "info") s.view = "profile"; // старые ссылки на «Полезное»
  if (v === "free") { s.view = "list"; s.freeScreen = true; }
  return s;
}

// Маршрут из адреса открываем после старта, когда план уже на экране
const h0 = new URLSearchParams(location.hash.slice(1));
export const initialRoute = getPlace(h0.get("rf")) || getPlace(h0.get("rt"))
  ? { from: getPlace(h0.get("rf")) ? h0.get("rf") : null, to: getPlace(h0.get("rt")) ? h0.get("rt") : null }
  : null;

let state = initialState();
const listeners = new Set<(s: AppState, prev: AppState) => void>();

export const getState = () => state;
export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  const prev = state;
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  listeners.forEach((fn) => fn(state, prev));
}
export const setRoute = (p: Partial<RouteState>) => setState((s) => ({ route: { ...s.route, ...p } }));
export function subscribe(fn: (s: AppState, prev: AppState) => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useApp<T>(sel: (s: AppState) => T): T {
  return useSyncExternalStore((cb) => subscribe(cb), () => sel(state));
}

/* ---------- адрес: состояние можно отправить ссылкой */
function writeHash(s: AppState) {
  const h = new URLSearchParams();
  if (s.campus !== "CT") h.set("c", s.campus);
  h.set("f", String(s.floor));
  if (s.date !== todayIso()) h.set("d", s.date);
  if (!s.live) h.set("t", fmt(s.t));
  if (s.room) h.set("r", s.room);
  const rot = ((Math.round(s.angle) % 360) + 360) % 360;
  if (rot) h.set("rot", String(rot));
  if (s.roomScreen && s.room) h.set("v", "room");
  else if (s.freeScreen && s.view === "list") h.set("v", "free");
  else if (s.view !== "plan") h.set("v", s.view);
  if (s.route.open) {
    if (s.route.from) h.set("rf", s.route.from);
    if (s.route.to) h.set("rt", s.route.to);
  }
  const next = "#" + h.toString();
  if (next !== location.hash) history.replaceState(null, "", next);
}
let hashQueued = false;
subscribe(() => {
  if (hashQueued) return;
  hashQueued = true;
  queueMicrotask(() => { hashQueued = false; writeHash(state); });
});
