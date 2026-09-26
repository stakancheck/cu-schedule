/* Данные, которые кладут в window сгенерированные скрипты из public/data. */

export type Pt = [number, number];

export interface VPath { d: string; eo: boolean }

export interface PlanRoom {
  id: string;
  label: string;
  color: string;
  pts: Pt[];
  area: number;
  tag: Pt;
  kind?: "class";
}

export interface PlanLabel {
  text: string;
  color: string;
  x: number;
  y: number;
  big: boolean;
  vertical?: boolean;
}

export interface PlanIcon { x: number; y: number; parts: { d: string; c: string; eo: boolean }[] }

export interface StreetText {
  x: number;
  y: number;
  size: number;
  text?: string;
  angle?: number;
  lines?: { text: string; dx: number; dy: number }[];
}

export interface Floor {
  n: number;
  summary?: string;
  extent: [number, number, number, number];
  floorPaths: VPath[];
  wallPaths: VPath[];
  voidPaths: VPath[];
  rooms: PlanRoom[];
  labels: PlanLabel[];
  icons: PlanIcon[];
  decorPaths?: VPath[];
  decorTexts?: StreetText[];
}

export interface Campus {
  id: string;
  name: string;
  short: string;
  floors: Record<string, Floor>;
  streets?: { paths: VPath[]; texts: StreetText[] };
  extent: Pt[];
}

/* Расписание: строки [дата, начало, конец, название, курс, тип, поток, [аудитории], преподаватели],
   текст - индексы в strings */
export type ScheduleRow = [string, string, string, number, number, number, number, number[], number];
export interface ScheduleData { strings: string[]; events: ScheduleRow[]; updatedAt?: string }

interface TgWebApp {
  platform: string;
  colorScheme: "light" | "dark";
  isExpanded: boolean;
  isFullscreen?: boolean;
  isVersionAtLeast(v: string): boolean;
  expand(): void;
  requestFullscreen(): void;
  ready(): void;
  onEvent(name: string, fn: (e?: { isStateStable?: boolean }) => void): void;
  disableVerticalSwipes(): void;
  setHeaderColor(c: string): void;
  setBackgroundColor(c: string): void;
  setBottomBarColor(c: string): void;
  openLink(url: string): void;
  openTelegramLink(url: string): void;
  BackButton: { show(): void; hide(): void; onClick(fn: () => void): void };
  HapticFeedback: { selectionChanged(): void; notificationOccurred(t: "success" | "error" | "warning"): void };
}

declare global {
  interface Window {
    CAMPUSES: Record<string, Campus>;
    SCHEDULE: ScheduleData;
    Telegram?: { WebApp?: TgWebApp };
  }
}
