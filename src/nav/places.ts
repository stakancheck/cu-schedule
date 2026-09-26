/* Места для маршрутов: аудитории, помещения, подписи плана, входы, «ближайшее», точки на плане */
import { CAMPUSES, centroid, roomFloor, type CampusId } from "../lib/schedule";
import { norm } from "../lib/util";
import { NAV } from "./data";
import type { GoalPoint } from "./engine";

export type PlaceKind = "room" | "space" | "poi" | "entrance" | "nearest" | "point";
export interface Place {
  key: string; kind: PlaceKind; title: string; sub: string;
  campus?: CampusId; floor?: number; x?: number; y?: number;
  room?: string; food?: boolean;
}
export type LocatedPlace = Place & { campus: CampusId; floor: number; x: number; y: number };

const all = new Map<string, Place>();
const NOT_PLACE = /^(с|со) -?\d+ на \d+$|^[BF]$|^Лифты?$|^Work in progress$|^Атриум$|^на \d этаж$/;
const FOOD = /Кухня|Кафе|Обеденный зал/;

for (const c of Object.values(CAMPUSES)) {
  for (const e of NAV[c.id]?.entrances || []) {
    all.set("e:" + e.id, { key: "e:" + e.id, kind: "entrance", campus: c.id, floor: e.floor, x: e.at[0], y: e.at[1], title: e.name, sub: e.sub || "" });
  }
  for (const f of Object.values(c.floors)) {
    for (const r of f.rooms) {
      const [x, y] = r.pts.length ? centroid(r.pts) : r.tag;
      const cls = !!roomFloor[r.id];
      all.set("r:" + r.id, {
        key: "r:" + r.id, kind: cls ? "room" : "space", room: r.id, campus: c.id, floor: f.n, x, y,
        title: cls ? r.id : r.label || r.id, sub: cls ? "" : r.label ? r.id : "", food: FOOD.test(r.label || ""),
      });
    }
    f.labels.forEach((l, i) => {
      if (NOT_PLACE.test(l.text)) return;
      const key = `p:${c.id}:${f.n}:${i}`;
      all.set(key, { key, kind: "poi", campus: c.id, floor: f.n, x: l.x, y: l.y, title: l.text, sub: "", food: FOOD.test(l.text) });
    });
  }
}

// «Ближайший …»: точки берутся из кампуса, откуда идём
export const NEAREST: Record<string, { title: string; points: (cid: CampusId) => GoalPoint[] }> = {
  "n:wc": { title: "Ближайший туалет", points: (cid) => (NAV[cid]?.wc || []).map(([floor, x, y]) => ({ floor, x, y })) },
  "n:food": {
    title: "Ближайшая кухня или кафе",
    points: (cid) => [...all.values()].filter((p): p is LocatedPlace => p.campus === cid && !!p.food)
      .map((p) => ({ floor: p.floor, x: p.x, y: p.y, title: p.title })),
  },
};
for (const [key, n] of Object.entries(NEAREST)) all.set(key, { key, kind: "nearest", title: n.title, sub: "" });

// Точка, указанная на плане: ключ «pt:кампус:этаж:x:y», в поиске её нет, создаём по запросу
export function getPlace(key: string | null | undefined): Place | undefined {
  if (!key) return undefined;
  const hit = all.get(key);
  if (hit) return hit;
  const m = /^pt:(\w+):(\d+):(-?[\d.]+):(-?[\d.]+)$/.exec(key);
  if (!m || !CAMPUSES[m[1]] || !CAMPUSES[m[1]].floors[m[2]]) return undefined;
  const p: Place = { key, kind: "point", campus: m[1], floor: +m[2], x: +m[3], y: +m[4], title: `Точка на плане, ${m[2]} этаж`, sub: "" };
  all.set(key, p);
  return p;
}
export const pointKey = (cid: CampusId, floor: number, x: number, y: number) => `pt:${cid}:${floor}:${x.toFixed(0)}:${y.toFixed(0)}`;

export const mainEntrance = (cid: CampusId) => [...all.values()].find((p) => p.kind === "entrance" && p.campus === cid);

export const placeName = (p: Place) => (p.kind === "room" ? `ауд. ${p.title}` : p.title);
export const placeWhere = (p: Place) => (p.kind === "nearest" ? "на вашем этаже или рядом"
  : [p.sub, `${p.floor} этаж`, p.campus ? CAMPUSES[p.campus].short : ""].filter(Boolean).join(" · "));

// Коды аудиторий набирают и в русской раскладке: «т318» = N318, «в914» = B914
const LAYOUT: Record<string, string> = { в: "b", и: "b", ф: "f", а: "f", н: "n", т: "n", с: "s", ы: "s", е: "e", у: "e", ц: "w" };
const KIND_RANK: Record<PlaceKind, number> = { room: 0, entrance: 1, nearest: 1, point: 1, poi: 2, space: 3 };

export interface Suggestion { p: Place; hint: string }

/* Подсказки для поля маршрута. Без запроса - входы кампуса, «ближайшее» и аудитории
   ваших пар на сегодня, с запросом - поиск по названиям. */
export function findPlaces(q: string, field: "from" | "to", cid: CampusId, other: string | null, myRooms: string[]): Suggestion[] {
  let nq = norm(q).replace(/^ауд\.?\s*/, "");
  if (/^[а-яё][\d.]+$/.test(nq) && LAYOUT[nq[0]]) nq = LAYOUT[nq[0]] + nq.slice(1);
  const pool = [...all.values()].filter((p) => p.key !== other && p.kind !== "point" && (field === "to" || p.kind !== "nearest"));
  if (!nq) {
    const mine = myRooms.map((r) => all.get("r:" + r)).filter((p): p is Place => !!p && p.key !== other);
    return [
      ...pool.filter((p) => p.kind === "entrance" && p.campus === cid),
      ...(field === "to" ? pool.filter((p) => p.kind === "nearest") : []),
      ...mine,
    ].map((p) => ({ p, hint: mine.includes(p) ? "ваша пара сегодня" : "" }));
  }
  const scored: { p: Place; s: number }[] = [];
  for (const p of pool) {
    const t = norm(p.title), sub = norm(p.sub);
    let s = t.startsWith(nq) ? 0 : t.split(/[\s«(]+/).some((w) => w.startsWith(nq)) ? 1 : t.includes(nq) ? 2 : sub.includes(nq) ? 3 : -1;
    if (s < 0) continue;
    s += KIND_RANK[p.kind] * 0.1 + (p.campus && p.campus !== cid ? 5 : 0);
    scored.push({ p, s });
  }
  scored.sort((a, b) => a.s - b.s || a.p.title.localeCompare(b.p.title, "ru"));
  // одинаковые подписи на этаже («Кухня») показываем один раз
  const seen = new Set<string>();
  return scored.filter(({ p }) => { const k = p.title + p.floor + p.campus; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 8).map(({ p }) => ({ p, hint: "" }));
}
