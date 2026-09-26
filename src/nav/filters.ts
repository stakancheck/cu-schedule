/* Подсветка мест одного типа на плане: «где туалеты», «где поесть». Включается из быстрых действий
   поиска, на плане - метки на местах и точки на этажах, где они есть, снимается чипом у плашки времени. */
import { floorNums, CAMPUSES, type CampusId } from "../lib/schedule";
import { placeInfo } from "./info";
import { placesOn, type Place } from "./places";

export interface Filter { title: string; img: string; test: (p: Place) => boolean }

// «Только для сотрудников» в подсветку не попадает: студенту туда не нужно
const forStudents = (p: Place) => !/сотрудник/i.test(placeInfo(p).note?.who || "");
const label = (p: Place) => p.label || p.title;

export const FILTERS: Record<string, Filter> = {
  wc: { title: "Туалеты", img: "quick-wc", test: (p) => p.kind === "wc" },
  food: { title: "Где поесть", img: "quick-food", test: (p) => !!p.food && forStudents(p) },
  cowork: { title: "Коворкинги", img: "quick-cowork", test: (p) => /^(Коворкинг|Опенспейс)/.test(label(p)) && !/сотрудник/.test(label(p)) },
  cloak: { title: "Гардеробы", img: "quick-cloak", test: (p) => /^Гардероб/.test(label(p)) && forStudents(p) },
};

export const filterOn = (cid: CampusId, n: number, id: string | null) =>
  id && FILTERS[id] ? placesOn(cid, n).filter((p) => p.kind !== "point" && FILTERS[id].test(p)) : [];

// Этажи кампуса, где есть места этого типа
export const filterFloors = (cid: CampusId, id: string | null) =>
  floorNums(CAMPUSES[cid]).filter((n) => filterOn(cid, n, id).length);
