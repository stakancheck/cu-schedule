/* Обращения с плана: отметка точки, отправка в API (оттуда в issue репозитория), сведения об устройстве.
   Текст проверяет сервер (worker/src/moderation.js); здесь только то, что можно сказать человеку сразу. */
import { API } from "./account";
import { toast } from "./actions";
import { CAMPUSES, type CampusId } from "./schedule";
import { getState, setState, type Pin, type ReportKind, type ReportState } from "./store";
import { haptic, inTg, tg } from "./telegram";
import { isPhone, lsGet, lsSet, norm } from "./util";
import { inPoly } from "../nav/engine";
import { getPlace } from "../nav/places";

export const TEXT_MIN = 10, TEXT_MAX = 1000;
const MIN_FILL_MS = 4000, LOG_KEY = "cu.fb.log", INTRO_KEY = "cu.fb.intro";
const LIMIT = { count: 3, window: 10 * 60e3 };

export const KIND_LABEL: Record<ReportKind, string> = { map: "Неточность", bug: "Сбой", idea: "Идея" };

/* ---------- что рядом с точкой */
export function describePoint(campus: CampusId, floor: number, x: number, y: number): Pick<Pin, "room" | "near"> {
  const f = CAMPUSES[campus].floors[floor];
  const inside = f.rooms.find((r) => r.pts.length > 2 && inPoly(x, y, r.pts));
  if (inside) {
    const p = getPlace("r:" + inside.id);
    return { room: inside.id, near: p && p.title !== inside.id ? p.title : "" };
  }
  // иначе ближайшая подпись или аудитория в пределах ~12 метров плана
  let best: { d: number; text: string } | null = null;
  const see = (px: number, py: number, text: string) => {
    const d = Math.hypot(px - x, py - y);
    if (d < 140 && (!best || d < best.d)) best = { d, text };
  };
  for (const r of f.rooms) see(r.tag[0], r.tag[1], r.label || r.id);
  for (const l of f.labels) see(l.x, l.y, l.text);
  return { room: "", near: (best as { text: string } | null)?.text.slice(0, 60) || "" };
}

export function pinAt(campus: CampusId, floor: number, x: number, y: number): Pin {
  return { campus, floor, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, ...describePoint(campus, floor, x, y) };
}

/* ---------- форма */
export function openReport({ kind = "map", pin = null, pick = false }: { kind?: ReportKind; pin?: Pin | null; pick?: boolean } = {}) {
  haptic.select();
  const s = getState();
  const keep = s.report;
  setState({
    search: false, mark: null, view: isPhone() ? "plan" : s.view, roomScreen: false,
    report: { text: "", contact: "", startedAt: Date.now(), ...keep, kind, picking: pick, pin: pin ?? keep?.pin ?? null },
    ...(pin ? { campus: pin.campus, floor: pin.floor } : {}),
  });
}

export const openReportAt = (key: string) => {
  const p = getPlace(key);
  if (!p?.campus || p.floor == null || p.x == null || p.y == null) return openReport();
  openReport({ kind: "map", pin: { campus: p.campus, floor: p.floor, x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, room: p.room || "", near: p.title } });
};

export const closeReport = () => setState({ report: null });
export const patchReport = (p: Partial<ReportState>) => setState((s) => (s.report ? { report: { ...s.report, ...p } } : {}));
export const startPin = () => patchReport({ picking: true });
export const cancelPick = () => patchReport({ picking: false });
export const clearPin = () => patchReport({ pin: null });

// Нажатие на план в режиме отметки
export function pickReportPoint(x: number, y: number) {
  const s = getState();
  if (!s.report?.picking) return;
  haptic.select();
  patchReport({ pin: pinAt(s.campus, s.floor, x, y), picking: false });
}

/* ---------- отправка */
export function wait(): number {
  const now = Date.now();
  let log: number[] = [];
  try { log = (JSON.parse(lsGet(LOG_KEY) || "[]") as number[]).filter((t) => now - t < LIMIT.window); } catch { /* повреждённая запись */ }
  return log.length >= LIMIT.count ? Math.ceil((LIMIT.window - (now - log[0])) / 60e3) : 0;
}
const remember = () => {
  const now = Date.now();
  let log: number[] = [];
  try { log = (JSON.parse(lsGet(LOG_KEY) || "[]") as number[]).filter((t) => now - t < LIMIT.window); } catch { /* повреждённая запись */ }
  lsSet(LOG_KEY, JSON.stringify([...log, now]));
};

export function deviceInfo() {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  return {
    app: typeof __BUILD__ === "string" ? __BUILD__ : "",
    screen: [screen.width, screen.height], viewport: [innerWidth, innerHeight], dpr: devicePixelRatio,
    lang: navigator.language, theme: dark ? "dark" : "light", touch: matchMedia("(pointer: coarse)").matches,
    tg: inTg && tg ? { platform: tg.platform, version: tg.version } : null,
  };
}

export const tgUsername = () => (inTg ? tg?.initDataUnsafe?.user?.username || "" : "");

// Что можно проверить без сервера: подсказка до отправки
export function check(r: ReportState): string | null {
  const t = r.text.trim();
  if (t.length < TEXT_MIN) return "Опишите подробнее: что не так и как должно быть.";
  if (t.length > TEXT_MAX) return `Слишком длинно: до ${TEXT_MAX} символов.`;
  if (r.kind === "map" && !r.pin && norm(t).length < 25) return "Если не отмечаете место на карте, назовите его в тексте: этаж и аудиторию.";
  return null;
}

export async function sendReport(r: ReportState, consent: boolean, trap: string): Promise<{ number: number; url?: string }> {
  const err = check(r);
  if (err) throw new Error(err);
  const m = wait();
  if (m) throw new Error(`Вы недавно отправляли обращения. Попробуйте через ${m} мин.`);
  const took = Date.now() - r.startedAt;
  if (took < MIN_FILL_MS) throw new Error("Слишком быстро. Проверьте текст и нажмите ещё раз.");
  let res: Response;
  try {
    res = await fetch(`${API}/v1/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: r.kind, text: r.text, contact: r.contact, consent, took, website: trap,
        pin: r.kind === "bug" ? null : r.pin,
        device: deviceInfo(),
      }),
    });
  } catch {
    throw new Error("Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.");
  }
  const j = (await res.json().catch(() => ({}))) as { number?: number; url?: string; message?: string };
  if (!res.ok) throw new Error(j.message || "Не удалось отправить. Попробуйте позже.");
  remember();
  haptic.ok();
  return { number: j.number || 0, url: j.url };
}

/* ---------- приглашение при первом запуске */
export const introSeen = () => lsGet(INTRO_KEY) === "1";
export const markIntroSeen = () => lsSet(INTRO_KEY, "1");

export function thanks() { toast("Спасибо! Обращение отправлено"); }
