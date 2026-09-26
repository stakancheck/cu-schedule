/* Время, даты, строки */

export const toMin = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
export const fmt = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

const pad = (n: number) => String(n).padStart(2, "0");
export const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseIso = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
export const addDays = (s: string, n: number) => { const d = parseIso(s); d.setDate(d.getDate() + n); return iso(d); };
export const todayIso = () => iso(new Date());
export const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };

export const dowFmt = new Intl.DateTimeFormat("ru-RU", { weekday: "long" });
export const dayFmt = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });
export const ghostFmt = new Intl.DateTimeFormat("ru-RU", { weekday: "short", day: "numeric" });

export const OTHER_DAY_T = 10 * 60; // другой день открываем на 10:00, а не на текущем времени

export const PHONE_MQ = "(max-width: 900px)";
export const isPhone = () => window.matchMedia(PHONE_MQ).matches;
export const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export const norm = (s: string | null | undefined) => (s || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();

export const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
export const lsSet = (k: string, v: string | null) => {
  try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* приватный режим */ }
};

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");
