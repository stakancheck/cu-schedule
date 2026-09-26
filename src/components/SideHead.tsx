/* Дата расписания. На телефоне даты листаются свайпом. */
import { useEffect, useRef, type RefObject } from "react";
import { useApp, getState } from "../lib/store";
import { setDate } from "../lib/actions";
import { haptic } from "../lib/telegram";
import { addDays, cx, dayFmt, dowFmt, ghostFmt, isPhone, parseIso, todayIso } from "../lib/util";
import { Icon } from "./icons";

const SWIPE_MIN = 56;      // столько нужно протянуть, чтобы сменить день
const FLICK_MIN = 24;      // короткий быстрый взмах тоже листает
const FLICK_SPEED = 0.35;  // px/мс
let swipedAt = 0;
// после свайпа палец отпускают над кнопкой: этот клик не нужен
document.addEventListener("click", (e) => {
  if (performance.now() - swipedAt < 350) { e.stopPropagation(); e.preventDefault(); }
}, true);

// палец начал на том, что само листается вбок: свайп по датам не мешает
function ownsHorizontal(t: Element | null, zone: HTMLElement) {
  if (t?.closest("input[type=range], input[type=search], input[type=text]")) return true;
  for (let el = t as HTMLElement | null; el && el !== zone; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(el).overflowX)) return true;
  }
  return false;
}

/* Свайп по датам: влево - следующий день, вправо - предыдущий.
   targets - что сдвигать вслед за пальцем, null - свайп сейчас выключен.
   Сенсорные события, а не pointer: направление решаем на первом движении пальца
   и для горизонтального жеста запрещаем прокрутку, иначе список перехватывает жест
   и браузер его отменяет. */
export function useSwipeDays(zone: RefObject<HTMLElement | null>, targets: () => (HTMLElement | null)[] | null) {
  const tRef = useRef(targets);
  tRef.current = targets;
  useEffect(() => {
    const el = zone.current;
    if (!el) return;
    // mode: null - направление ещё не ясно, "x" - листаем дни, "y" - это прокрутка
    let s: { id: number; x: number; y: number; dx: number; mode: "x" | "y" | null; hist: [number, number][] } | null = null;
    const move = (dx: number, anim = false) => {
      for (const t of tRef.current() || []) {
        if (!t) continue;
        t.style.transition = anim ? "transform .28s cubic-bezier(.2, .8, .3, 1), opacity .28s" : "none";
        t.style.transform = dx ? `translateX(${dx}px)` : "";
        t.style.opacity = dx ? String(1 - Math.min(0.6, Math.abs(dx) / 260)) : "";
      }
    };
    const find = (list: TouchList, id: number) => [...list].find((t) => t.identifier === id);
    const start = (e: TouchEvent) => {
      if (e.touches.length > 1) { if (s?.mode === "x") move(0, true); s = null; return; }
      if (!isPhone() || !tRef.current() || ownsHorizontal(e.target as Element, el)) { s = null; return; }
      const t = e.changedTouches[0];
      s = { id: t.identifier, x: t.clientX, y: t.clientY, dx: 0, mode: null, hist: [[performance.now(), t.clientX]] };
    };
    const mv = (e: TouchEvent) => {
      if (!s) return;
      const t = find(e.changedTouches, s.id);
      if (!t) return;
      const dx = t.clientX - s.x, dy = t.clientY - s.y;
      if (!s.mode) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        // вбок - если горизонталь хотя бы не меньше вертикали: наклонный жест тоже листает
        s.mode = Math.abs(dx) >= Math.abs(dy) * 0.9 ? "x" : "y";
      }
      if (s.mode === "y") return;
      if (e.cancelable) e.preventDefault();
      s.dx = dx;
      const now = performance.now();
      s.hist.push([now, t.clientX]);
      while (s.hist.length > 2 && now - s.hist[0][0] > 100) s.hist.shift();
      move(dx * 0.6);
    };
    const end = (e: TouchEvent) => {
      if (!s) return;
      const t = find(e.changedTouches, s.id);
      if (!t) return;
      const { mode, dx, hist } = s;
      s = null;
      if (mode !== "x") return;
      swipedAt = performance.now();
      // скорость за последние ~100 мс: быстрый взмах листает и без длинного хода
      const [t0, x0] = hist[0];
      const v = (t.clientX - x0) / Math.max(1, performance.now() - t0);
      const go = e.type === "touchend" && (Math.abs(dx) >= SWIPE_MIN || (Math.abs(dx) >= FLICK_MIN && Math.abs(v) >= FLICK_SPEED && Math.sign(v) === Math.sign(dx)));
      if (!go) return move(0, true);
      const dir = dx < 0 ? 1 : -1;
      setDate(addDays(getState().date, dir));
      haptic.select();
      // новый день въезжает с той стороны, куда тянули
      move(dir * 70);
      requestAnimationFrame(() => move(0, true));
    };
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", mv, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", mv);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
    };
  }, [zone]);
}

export function SideHead() {
  const date = useApp((s) => s.date);
  const row = useRef<HTMLDivElement>(null);
  useSwipeDays(row, () => [row.current]);
  const d = parseIso(date), today = todayIso();
  return (
    <div className="side-head">
      <div className="date-row" ref={row} id="dateRow">
        <button className="icon-btn" id="prevDay" title="Предыдущий день" onClick={() => setDate(addDays(date, -1))}><Icon name="back" /></button>
        {/* на телефоне вместо стрелок: соседние дни по краям, листаются свайпом */}
        <span className="date-ghost prev" aria-hidden="true">{ghostFmt.format(parseIso(addDays(date, -1)))}</span>
        <label className="date-main" title="Выбрать дату">
          <span className="dow">{dowFmt.format(d)}</span>
          <span className="dnum">{dayFmt.format(d)}</span>
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </label>
        <span className="date-ghost next" aria-hidden="true">{ghostFmt.format(parseIso(addDays(date, 1)))}</span>
        <button className="icon-btn" id="nextDay" title="Следующий день" onClick={() => setDate(addDays(date, 1))}><Icon name="next" /></button>
      </div>
      <div className="quick-days">
        {([["Вчера", addDays(today, -1)], ["Сегодня", today], ["Завтра", addDays(today, 1)]] as const).map(([label, v]) => (
          <button key={label} className={cx(v === date && "on")} onClick={() => setDate(v)}>{label}</button>
        ))}
      </div>
    </div>
  );
}
