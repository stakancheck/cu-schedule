/* Маршрут в словах: шаги пошагового режима, названия вариантов */
import type { Leg, NavLink, RouteOption } from "./engine";
import type { Place } from "./places";
import { ADDRESS, CITY_TITLE, type CityLeg, type CityMode } from "./city";

export type AnyLeg = Leg | CityLeg;
export type StepKind = "walk" | "stairs" | "lift" | CityMode;
// campus - где идёт шаг (в маршруте между кампусами), floor - этаж, который показать на плане
export interface Step { leg: AnyLeg; kind: StepKind; floor: number; title: string; text: string; meta: string; campus?: string }
export type Option = Omit<RouteOption, "legs"> & { legs: AnyLeg[]; steps: Step[]; city?: CityLeg };

export const fmtDur = (s: number) => (s < 45 ? "меньше минуты" : `≈ ${Math.round(s / 60)} мин`);
export const fmtLen = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1).replace(".", ",")} км` : `${Math.max(5, Math.round(m / 5) * 5)} м`);
const linkWord = (l: NavLink) => (l.kind === "lift" ? "лифта" : "лестницы") + (l.name ? " " + l.name : "");

function goalWord(b: Place, goal: RouteOption["goal"]) {
  if (b.kind === "nearest") return b.key === "n:wc" ? "туалета" : `«${goal.title}»`;
  if (b.kind === "room") return `аудитории ${b.title}`;
  if (b.kind === "entrance") return `выхода: ${b.title.toLowerCase()}`;
  if (b.kind === "point") return "отмеченной точки";
  return `«${b.title}»`;
}

// Пешие отрезки и переходы между этажами
export function stepsOf(o: RouteOption, to: Place): Step[] {
  const out: Step[] = [];
  o.legs.forEach((leg, i) => {
    const last = i === o.legs.length - 1;
    if (leg.type === "walk") {
      if (!last && leg.len < 4) return; // старт прямо у лестницы
      const where = !out.length && !last ? ` по ${leg.floor} этажу` : "";
      out.push({ leg, kind: "walk", floor: leg.floor, title: `${leg.floor} этаж`,
        text: `Пройдите${where} до ${last ? goalWord(to, o.goal) : linkWord(leg.toLink!)}`, meta: fmtLen(leg.len) });
    } else {
      const verb = leg.to > leg.from ? "Поднимитесь" : "Спуститесь";
      out.push({ leg, kind: leg.kind, floor: leg.to, title: `${leg.from} → ${leg.to} этаж`,
        text: leg.kind === "lift" ? `${verb} на лифте на ${leg.to} этаж` : `${verb} по лестнице на ${leg.to} этаж`,
        meta: [(leg.kind === "lift" ? "лифт" : "лестница") + (leg.link.name ? " " + leg.link.name : ""), fmtDur(leg.time)].join(" · ") });
    }
  });
  return out;
}

// Шаг по городу: показываем на плане выход, из которого идём
export function cityStep(c: CityLeg, floor: number): Step {
  return { leg: c, kind: c.mode, floor, campus: c.from, title: "По городу",
    text: `${CITY_TITLE[c.mode]} в ${ADDRESS[c.to].name}`, meta: `${fmtDur(c.time)} · ${ADDRESS[c.to].addr}` };
}

export function optTitle(o: Option, i: number) {
  if (o.city) return CITY_TITLE[o.city.mode];
  if (i === 0) return "Рекомендуемый";
  if (o.kinds.length === 1 && o.kinds[0] === "lift") return "Без лестниц";
  if (o.kinds.length === 1 && o.kinds[0] === "stairs") return "Без лифта";
  return "Другой путь";
}
