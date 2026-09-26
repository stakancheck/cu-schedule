/* Места: аудитории, помещения, подписи плана, входы, туалеты, лестницы и лифты, «ближайшее», точки на плане.
   Из них выбирают начало и конец маршрута, их же находит общий поиск и открывает нажатие на план. */
import { CAMPUSES, centroid, roomFloor, type CampusId } from "../lib/schedule";
import { norm } from "../lib/util";
import { NAV } from "./data";
import { NOTES } from "./info";
import { inPoly, type GoalPoint } from "./engine";

export type PlaceKind = "room" | "space" | "poi" | "entrance" | "wc" | "link" | "nearest" | "point";
export interface Place {
  key: string; kind: PlaceKind; title: string; sub: string;
  campus?: CampusId; floor?: number; x?: number; y?: number;
  room?: string; food?: boolean;
  label?: string;  // подпись с плана как есть (у помещения без подписи пустая)
  color?: string;  // цвет подписи или заливки на плане: kitchen, staff, ...
}
export type LocatedPlace = Place & { campus: CampusId; floor: number; x: number; y: number };

const all = new Map<string, Place>();
const alias = new Map<string, string>(); // подпись плана, которая на деле название помещения -> ключ помещения
const NOT_PLACE = /^(с|со) -?\d+ на \d+$|^[BF]$|^Лифты?$|^Work in progress$|^Атриум$|^на \d этаж$/;
const FOOD = /Кухня|Кафе|Обеденный зал/;
const WC_NAME = { f: "Женский туалет", m: "Мужской туалет", a: "Туалет для маломобильных" };

for (const c of Object.values(CAMPUSES)) {
  for (const e of NAV[c.id]?.entrances || []) {
    all.set("e:" + e.id, { key: "e:" + e.id, kind: "entrance", campus: c.id, floor: e.floor, x: e.at[0], y: e.at[1], title: e.name, sub: e.sub || "" });
  }
  for (const f of Object.values(c.floors)) {
    for (const r of f.rooms) {
      const [x, y] = r.pts.length ? centroid(r.pts) : r.tag;
      const cls = !!roomFloor[r.id];
      // помещение без подписи на плане, но с названием в справочнике
      const label = r.label || (!cls && NOTES[r.id]?.title) || "";
      all.set("r:" + r.id, {
        key: "r:" + r.id, kind: cls ? "room" : "space", room: r.id, campus: c.id, floor: f.n, x, y,
        title: cls ? r.id : label || `Помещение ${r.id}`, sub: cls || !label ? "" : r.id, food: FOOD.test(label),
        label, color: r.color,
      });
    }
    f.labels.forEach((l, i) => {
      if (NOT_PLACE.test(l.text)) return;
      const key = `p:${c.id}:${f.n}:${i}`;
      // подпись внутри помещения без своего названия - это его название («Группа размещения студентов» в B503)
      const r = f.rooms.find((r) => !r.label && !roomFloor[r.id] && r.pts.length > 2 && inPoly(l.x, l.y, r.pts));
      const rp = r && all.get("r:" + r.id);
      if (rp) {
        Object.assign(rp, { title: l.text, sub: r!.id, label: l.text, color: l.color, food: FOOD.test(l.text) });
        alias.set(key, rp.key);
        return;
      }
      all.set(key, { key, kind: "poi", campus: c.id, floor: f.n, x: l.x, y: l.y, title: l.text, sub: "", food: FOOD.test(l.text), color: l.color });
    });
  }
  (NAV[c.id]?.wc || []).forEach(([floor, x, y, k], i) => {
    const key = `w:${c.id}:${i}`;
    all.set(key, { key, kind: "wc", campus: c.id, floor, x, y, title: WC_NAME[k], sub: "" });
  });
  // лестница или лифт - отдельное место на каждом этаже, где есть выход
  for (const l of NAV[c.id]?.links || []) {
    const floors = Object.keys(l.at).map(Number).sort((a, b) => a - b);
    const sub = [
      l.name,
      // подряд - диапазоном, с пропусками - списком (лифт Дуката на 1, 3, 7 и 10)
      floors.length > 1 && (floors[floors.length - 1] - floors[0] === floors.length - 1
        ? `этажи ${floors[0]}–${floors[floors.length - 1]}` : `этажи ${floors.join(", ")}`),
      l.oneway && (l.oneway === "up" ? "только вверх" : "только вниз"),
      l.closed && (l.kind === "lift" ? "сейчас закрыт" : "сейчас закрыта"),
    ].filter(Boolean).join(", ");
    for (const n of floors) {
      const key = `l:${c.id}:${l.id}:${n}`;
      all.set(key, { key, kind: "link", campus: c.id, floor: n, x: l.at[n][0], y: l.at[n][1], title: l.kind === "lift" ? "Лифт" : "Лестница", sub });
    }
  }
}

// Места по этажам: для иконок на плане и соседей
const byFloor = new Map<string, Place[]>();
for (const p of all.values()) {
  if (p.campus == null) continue;
  const k = p.campus + ":" + p.floor;
  (byFloor.get(k) || byFloor.set(k, []).get(k)!).push(p);
}
export const placesOn = (cid: CampusId, n: number) => byFloor.get(cid + ":" + n) || [];
// Место подписи плана с номером i (или помещения, названием которого она служит)
export const labelPlace = (cid: CampusId, n: number, i: number) => getPlace(`p:${cid}:${n}:${i}`);
export const allPlaces = () => all.values();

// Иконка на плане -> место. Значок кухни - ближайшая кухня или кафе. Остальные: туалет в той же точке,
// лестница или лифт (в Дукате четыре иконки лифтов вокруг одной точки разметки), иначе подпись рядом
// («Гардероб», «Ресепшн»)
const ICON_REACH: Partial<Record<PlaceKind, number>> = { wc: 30, link: 130 };
export function iconPlace(cid: CampusId, n: number, x: number, y: number, kitchen: boolean) {
  const near = (ok: (p: Place) => number | undefined) => {
    let best: Place | null = null, bd = Infinity;
    for (const p of placesOn(cid, n)) {
      const reach = ok(p), d = Math.hypot(p.x! - x, p.y! - y);
      if (reach != null && d < reach && d < bd) { bd = d; best = p; }
    }
    return best;
  };
  if (kitchen) return near((p) => (p.food ? 220 : undefined));
  return near((p) => ICON_REACH[p.kind]) || near((p) => (p.kind === "poi" ? 65 : undefined));
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
  const hit = all.get(alias.get(key) ?? key);
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
const KIND_RANK: Record<PlaceKind, number> = { room: 0, entrance: 1, nearest: 1, point: 1, poi: 2, wc: 2, space: 3, link: 4 };

// Запрос к местам: «ауд. 318» = «318», «т318» = «n318»
export function normQuery(q: string) {
  let nq = norm(q).replace(/^ауд\.?\s*/, "");
  if (/^[а-яё][\d.]+$/.test(nq) && LAYOUT[nq[0]]) nq = LAYOUT[nq[0]] + nq.slice(1);
  return nq;
}

export interface Suggestion { p: Place; hint: string }

/* Подсказки для поля маршрута. Без запроса - входы кампуса, «ближайшее» и аудитории
   ваших пар на сегодня, с запросом - поиск по названиям. */
export function findPlaces(q: string, field: "from" | "to", cid: CampusId, other: string | null, myRooms: string[]): Suggestion[] {
  const nq = normQuery(q);
  const pool = [...all.values()].filter((p) => p.key !== other && p.kind !== "point" && p.kind !== "link" && (field === "to" || p.kind !== "nearest"));
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
