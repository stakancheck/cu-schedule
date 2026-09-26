/* Дорога между кампусами по городу: способы, время и ссылка на Яндекс Карты.
   Время ориентировочное, по картам на сентябрь 2026; точный путь и пробки - в Картах. */
import type { CampusId } from "../lib/schedule";

export type CityMode = "metro" | "bus" | "street" | "scooter";
export interface CityLeg {
  type: "city"; mode: CityMode; from: CampusId; to: CampusId;
  time: number;      // секунды, от выхода из одного здания до входа в другое
  walk: number;      // метры пешком по улице
  lines: string[];   // как ехать, по шагам
  url: string;
}

// Где здания на карте и через какой вход в них попадают с улицы
export const ADDRESS: Record<string, { name: string; addr: string; ll: [number, number]; entrance: string }> = {
  CT: { name: "Центральный телеграф", addr: "Тверская ул., 7", ll: [55.75766, 37.61203], entrance: "e:ct-main" },
  DUCAT: { name: "Дукат", addr: "ул. Гашека, 7с1", ll: [55.768715, 37.589025], entrance: "e:du-main" },
};

// Яндекс Карты строят маршрут выбранным транспортом: mt - общественный, pd - пешком, sc - самокат
const RTT: Record<CityMode, string> = { metro: "mt", bus: "mt", street: "pd", scooter: "sc" };
const mapsUrl = (from: CampusId, to: CampusId, mode: CityMode) => {
  const a = ADDRESS[from].ll, b = ADDRESS[to].ll;
  return `https://yandex.ru/maps/?rtext=${a.join(",")}~${b.join(",")}&rtt=${RTT[mode]}`;
};

type Plan = { mode: CityMode; min: number; walk: number; lines: string[] };
// Описано из ЦТ в Дукат; обратно те же шаги в обратном порядке
const CT_TO_DUCAT: Plan[] = [
  { mode: "metro", min: 22, walk: 1250, lines: [
    "Пешком до метро «Театральная», ≈ 6 мин",
    "Замоскворецкая линия в сторону «Ховрино», 2 остановки до «Маяковской»",
    "От «Маяковской» пешком до ул. Гашека, ≈ 9 мин",
  ] },
  { mode: "bus", min: 25, walk: 900, lines: [
    "Остановка «Тверская площадь» на той же стороне Тверской, ≈ 3 мин",
    "Автобус м1 в сторону Белорусского вокзала, 3 остановки до «Метро Маяковская»",
    "От остановки до ул. Гашека, ≈ 9 мин",
  ] },
  { mode: "street", min: 30, walk: 2400, lines: [
    "Вверх по Тверской мимо Пушкинской площади до Садового кольца",
    "От «Маяковской» к ул. Гашека",
  ] },
  { mode: "scooter", min: 13, walk: 150, lines: [
    "Самокат с парковки у здания, по Тверской до Садового кольца",
    "На Тверской и в центре бывают зоны медленной езды и запрета парковки: смотрите в приложении",
  ] },
];

const REVERSE: Record<CityMode, string[]> = {
  metro: [
    "Пешком до метро «Маяковская», ≈ 9 мин",
    "Замоскворецкая линия в сторону «Алма-Атинской», 2 остановки до «Театральной»",
    "Выход к Тверской улице, до ЦТ ≈ 6 мин",
  ],
  bus: [
    "От ул. Гашека до остановки «Метро Маяковская» на Тверской, ≈ 9 мин",
    "Автобус м1 в сторону центра, 3 остановки до «Тверской площади»",
    "До ЦТ ≈ 3 мин по той же стороне",
  ],
  street: [
    "От ул. Гашека к «Маяковской» и Тверской",
    "Вниз по Тверской мимо Пушкинской площади до Центрального телеграфа",
  ],
  scooter: [
    "Самокат с парковки у здания, к Тверской и по ней в сторону центра",
    "На Тверской и в центре бывают зоны медленной езды и запрета парковки: смотрите в приложении",
  ],
};

export function cityLegs(from: CampusId, to: CampusId): CityLeg[] {
  if (!ADDRESS[from] || !ADDRESS[to] || from === to) return [];
  const back = from === "DUCAT";
  return CT_TO_DUCAT.map((p) => ({
    type: "city", mode: p.mode, from, to, time: p.min * 60, walk: p.walk,
    lines: back ? REVERSE[p.mode] : p.lines, url: mapsUrl(from, to, p.mode),
  }));
}

export const CITY_TITLE: Record<CityMode, string> = { metro: "На метро", bus: "На автобусе", street: "Пешком по улице", scooter: "На самокате" };
