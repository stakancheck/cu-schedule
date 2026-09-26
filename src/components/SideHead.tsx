/* Дата и время плана. На телефоне даты листаются свайпом. */
import { useEffect, useRef, type RefObject } from "react";
import { useApp, getState } from "../lib/store";
import { goNow, setDate, setTime } from "../lib/actions";
import { haptic } from "../lib/telegram";
import { DAY_END, DAY_START } from "../lib/schedule";
import { addDays, cx, dayFmt, dowFmt, fmt, ghostFmt, isPhone, parseIso, todayIso } from "../lib/util";
import { Icon } from "./icons";

const SWIPE_MIN = 56;
let swipedAt = 0;
// после свайпа палец отпускают над кнопкой: этот клик не нужен
document.addEventListener("click", (e) => {
  if (performance.now() - swipedAt < 350) { e.stopPropagation(); e.preventDefault(); }
}, true);

/* Свайп по датам: влево - следующий день, вправо - предыдущий.
   targets - что сдвигать вслед за пальцем, null - свайп сейчас выключен. */
export function useSwipeDays(zone: RefObject<HTMLElement | null>, targets: () => (HTMLElement | null)[] | null) {
  const tRef = useRef(targets);
  tRef.current = targets;
  useEffect(() => {
    const el = zone.current;
    if (!el) return;
    let s: { id: number; x: number; y: number; dx: number; on: boolean } | null = null;
    const move = (dx: number, anim = false) => {
      for (const t of tRef.current() || []) {
        if (!t) continue;
        t.style.transition = anim ? "transform .28s cubic-bezier(.2, .8, .3, 1), opacity .28s" : "none";
        t.style.transform = dx ? `translateX(${dx}px)` : "";
        t.style.opacity = dx ? String(1 - Math.min(0.6, Math.abs(dx) / 260)) : "";
      }
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType === "mouse" || !isPhone() || !tRef.current() || (e.target as Element).closest("input[type=range], input[type=search], input[type=text]")) return;
      s = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, on: false };
    };
    const mv = (e: PointerEvent) => {
      if (!s || e.pointerId !== s.id) return;
      const dx = e.clientX - s.x, dy = e.clientY - s.y;
      if (!s.on) {
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { s = null; return; } // это вертикальный скролл
        if (Math.abs(dx) < 10) return;
        s.on = true;
        el.setPointerCapture(e.pointerId);
      }
      s.dx = dx;
      move(dx * 0.6);
    };
    const end = (e: PointerEvent) => {
      if (!s || e.pointerId !== s.id) return;
      const { on, dx } = s;
      s = null;
      if (!on) return;
      swipedAt = performance.now();
      if (e.type !== "pointerup" || Math.abs(dx) < SWIPE_MIN) return move(0, true);
      const dir = dx < 0 ? 1 : -1;
      setDate(addDays(getState().date, dir));
      haptic.select();
      // новый день въезжает с той стороны, куда тянули
      move(dir * 70);
      requestAnimationFrame(() => move(0, true));
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", mv);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", mv);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
    };
  }, [zone]);
}

export function SideHead() {
  const date = useApp((s) => s.date), t = useApp((s) => s.t), live = useApp((s) => s.live);
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
      <div className="time-row">
        <span className="time-lbl">План на</span>
        <span className="time-val">{fmt(t)}</span>
        <input type="range" min={DAY_START} max={DAY_END} step={5} value={Math.min(DAY_END, Math.max(DAY_START, t))}
          onChange={(e) => setTime(+e.target.value)} />
        <button className={cx("chip-btn", live && "on")} onClick={goNow}>Сейчас</button>
      </div>
    </div>
  );
}
