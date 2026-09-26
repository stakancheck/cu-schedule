/* Общее расписание: пары по датам, занятость и статусы аудиторий */
import type { Campus, Pt } from "../types";
import { toMin } from "./util";

export const DAY_START = 8 * 60;   // границы «рабочего дня» для свободных окон
export const DAY_END = 22 * 60;
const SOON_MIN = 30;               // «скоро пара», если до начала меньше получаса
const MIN_WINDOW = 15;             // окна короче не показываем

export const CAMPUSES = window.CAMPUSES;
export type CampusId = string;
const S = window.SCHEDULE;
const str = S.strings;
export const updatedAt = S.updatedAt;

export interface Ev {
  date: string; start: string; end: string; s: number; e: number;
  title: string; course: string; type: string; stream: string; teachers: string;
  rooms: string[]; campus: CampusId; search: string;
}

export function centroid(pts: Pt[]): Pt {
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

// Аудитории с расписанием: class-комнаты (в ЦТ все учебные) и помещения
// из PDF-плана, которые встречаются в расписании. Коды уникальны между кампусами.
const scheduled = new Set<string>();
for (const row of S.events) for (const i of row[7]) scheduled.add(str[i]);
export const roomFloor: Record<string, number> = {};
export const roomCampus: Record<string, CampusId> = {};
for (const c of Object.values(CAMPUSES)) {
  for (const f of Object.values(c.floors)) {
    for (const r of f.rooms) {
      const isClass = r.kind === "class" || (r.pts && r.pts.length && scheduled.has(r.id));
      if (isClass) { roomFloor[r.id] = f.n; roomCampus[r.id] = c.id; }
    }
  }
  // рамка кампуса: у ЦТ задана парсером (с улицами), у Дуката собираем из рамок этажей
  if (!c.extent) {
    const e = Object.values(c.floors).map((f) => f.extent);
    const x0 = Math.min(...e.map((v) => v[0])), y0 = Math.min(...e.map((v) => v[1]));
    const x1 = Math.max(...e.map((v) => v[2])), y1 = Math.max(...e.map((v) => v[3]));
    c.extent = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  }
}

export const floorNums = (c: Campus) => Object.keys(c.floors).map(Number).sort((a, b) => a - b);
// первый этаж, где есть аудитории с расписанием
export const defaultFloor = (c: Campus) => floorNums(c).find((n) =>
  Object.keys(roomFloor).some((r) => roomCampus[r] === c.id && roomFloor[r] === n)) || floorNums(c)[0];
export const isClassRoom = (id: string | null | undefined): id is string => !!id && !!roomFloor[id];

export const byDate = new Map<string, Ev[]>();
export let dataMin = "9999", dataMax = "0000";
for (const row of S.events) {
  const [date, start, end, title, course, type, stream, rooms, teachers] = row;
  if (date < dataMin) dataMin = date;
  if (date > dataMax) dataMax = date;
  const rs = rooms.map((i) => str[i]).filter((r) => roomFloor[r]);
  if (!rs.length) continue;
  const ev: Ev = {
    date, start, end, s: toMin(start), e: toMin(end),
    title: str[title], course: str[course], type: str[type],
    stream: str[stream], teachers: str[teachers], rooms: rs, campus: roomCampus[rs[0]], search: "",
  };
  ev.search = `${ev.title} ${ev.course} ${ev.stream} ${ev.teachers} ${rs.join(" ")}`.toLowerCase();
  if (!byDate.has(date)) byDate.set(date, []);
  byDate.get(date)!.push(ev);
}
for (const list of byDate.values()) {
  list.sort((a, b) => a.s - b.s || a.e - b.e || a.rooms[0].localeCompare(b.rooms[0]));
}
export const eventsOn = (date: string) => byDate.get(date) || [];

export interface Block { s: number; e: number; evs: Ev[] }

// Занятость по аудиториям на дату, с объединением стыкующихся пар
const occCache = new Map<string, Record<string, Block[]>>();
export function occupancy(date: string) {
  const hit = occCache.get(date);
  if (hit) return hit;
  const map: Record<string, Ev[]> = {};
  for (const ev of eventsOn(date)) for (const r of ev.rooms) (map[r] ||= []).push(ev);
  const res: Record<string, Block[]> = {};
  for (const [room, evs] of Object.entries(map)) {
    evs.sort((a, b) => a.s - b.s);
    const merged: Block[] = [];
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

export type RoomState = "free" | "soon" | "busy";
export interface Status { st: RoomState; until: number | null; ev?: Ev; next?: Ev }

export function roomStatus(room: string, date: string, t: number): Status {
  for (const b of occupancy(date)[room] || []) {
    if (b.s <= t && t < b.e) {
      const cur = b.evs.find((ev) => ev.s <= t && t < ev.e) || b.evs[0];
      return { st: "busy", until: b.e, ev: cur };
    }
    if (b.s > t) return { st: b.s - t <= SOON_MIN ? "soon" : "free", until: b.s, next: b.evs[0] };
  }
  return { st: "free", until: null };
}

export function freeWindows(room: string, date: string) {
  const out: [number, number][] = [];
  let cur = DAY_START;
  for (const b of occupancy(date)[room] || []) {
    if (b.s - cur >= MIN_WINDOW) out.push([cur, Math.min(b.s, DAY_END)]);
    cur = Math.max(cur, b.e);
  }
  if (DAY_END - cur >= MIN_WINDOW) out.push([cur, DAY_END]);
  return out;
}

export const evKind = (type: string) =>
  type === "Лекция" ? "lec" : /Контрольная|Экзамен|Пересдача/.test(type) ? "ctrl" : type === "Семинар" ? "" : "other";

export function autoSummary(c: Campus, n: number) {
  const f = c.floors[n];
  if (f.summary) return f.summary;
  const rooms = f.rooms.filter((r) => roomFloor[r.id]).map((r) => r.id);
  const extra = [...new Set([...f.rooms.map((r) => r.label), ...f.labels.map((l) => l.text)]
    .filter((t) => /^(Коворкинг|Кафе|Кухня|Библиотека|Зона отдыха)/.test(t || ""))
    .map((t) => t.split(/[ /]/)[0].toLowerCase()))];
  const parts = [];
  if (rooms.length) parts.push(`Аудитории ${rooms.join(", ")}`);
  if (extra.length) parts.push(extra.join(", "));
  return parts.join("; ") || "Пар по расписанию на этаже нет";
}
