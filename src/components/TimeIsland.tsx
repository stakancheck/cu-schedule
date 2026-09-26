/* Занятость на плане: по умолчанию живое время, остров с датой, временем и легендой по кнопке */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useApp } from "../lib/store";
import { goNow, planCtl, setDate, setTime } from "../lib/actions";
import { dayRange, hourMarks, occupancy, roomCampus, roomFloor, type CampusId } from "../lib/schedule";
import { addDays, cx, dayFmt, dowFmt, fmt, ghostFmt, isPhone, nowMin, parseIso, todayIso } from "../lib/util";
import { Icon } from "./icons";

function relDay(date: string) {
  const today = todayIso();
  return date === today ? "Сегодня" : date === addDays(today, 1) ? "Завтра" : date === addDays(today, -1) ? "Вчера" : null;
}

// Шкала в часы работы кампуса: пересчёт времени в долю ширины и обратно
function scaleOf(campus: CampusId) {
  const [start, end] = dayRange(campus), span = end - start;
  const bucket = span > 16 * 60 ? 15 : 10; // минут в столбике загрузки
  const clamp = (t: number) => Math.min(end, Math.max(start, t));
  return { start, end, span, bucket, clamp, pct: (t: number) => ((clamp(t) - start) / span) * 100 };
}

// Сколько аудиторий выбранного этажа занято: по столбикам дня и в выбранную минуту
function useLoad(date: string, t: number) {
  const campus = useApp((s) => s.campus), floor = useApp((s) => s.floor);
  const here = (room: string) => roomCampus[room] === campus && roomFloor[room] === floor;
  const bars = useMemo(() => {
    const { start, span, bucket } = scaleOf(campus);
    const out = new Array<number>(Math.ceil(span / bucket)).fill(0);
    for (const [room, blocks] of Object.entries(occupancy(date))) {
      if (!here(room)) continue;
      for (const b of blocks) {
        const i0 = Math.max(0, Math.floor((b.s - start) / bucket)), i1 = Math.min(out.length, Math.ceil((b.e - start) / bucket));
        for (let i = i0; i < i1; i++) out[i]++;
      }
    }
    return out;
  }, [date, campus, floor]);
  const total = useMemo(() => Object.keys(roomFloor).filter(here).length, [campus, floor]);
  const busy = useMemo(() => {
    let n = 0;
    for (const [room, blocks] of Object.entries(occupancy(date)))
      if (here(room) && blocks.some((b) => b.s <= t && t < b.e)) n++;
    return n;
  }, [date, campus, floor, t]);
  return { campus, bars, max: Math.max(1, ...bars), busy, total };
}

function BusyNote({ date, t }: { date: string; t: number }) {
  const { campus, busy, total } = useLoad(date, t);
  const [start, end] = dayRange(campus);
  if (t < start || t >= end) return <span className="ti-busy">кампус закрыт</span>;
  if (!total) return <span className="ti-busy">на этаже нет аудиторий</span>;
  return <span className="ti-busy">на этаже занято {busy} из {total}</span>;
}

// Шкала дня: загрузка этажа столбиками, часы, отметка «сейчас» и бегунок
function Timeline({ date, t, live }: { date: string; t: number; live: boolean }) {
  const { campus, bars, max } = useLoad(date, t);
  const { start, end, span, clamp, pct } = scaleOf(campus);
  const track = useRef<HTMLDivElement>(null);
  const today = todayIso(), now = nowMin();
  const nowIn = date === today && now > start && now < end;
  const nowAt = date === today ? pct(now) : date < today ? 100 : 0;

  const fromX = (x: number) => {
    const r = track.current!.getBoundingClientRect();
    const k = Math.min(1, Math.max(0, (x - r.left) / r.width));
    return clamp(Math.round((start + k * span) / 5) * 5);
  };
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    setTime(fromX(e.clientX));
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) setTime(fromX(e.clientX));
  };
  const onKey = (e: ReactKeyboardEvent) => {
    const step = { ArrowLeft: -5, ArrowRight: 5, ArrowDown: -5, ArrowUp: 5, PageDown: -60, PageUp: 60 }[e.key];
    if (step) setTime(clamp(t + (e.shiftKey ? step * 6 : step)));
    else if (e.key === "Home") setTime(start);
    else if (e.key === "End") setTime(end);
    else return;
    e.preventDefault();
  };

  return (
    <div className={cx("tl", live && "live")} ref={track} role="slider" tabIndex={0} aria-label="Время"
      aria-valuemin={start} aria-valuemax={end} aria-valuenow={clamp(t)} aria-valuetext={fmt(t)}
      onPointerDown={onDown} onPointerMove={onMove} onKeyDown={onKey}>
      <div className="tl-bars">
        {bars.map((v, i) => <i key={i} style={{ height: `${v ? 12 + (v / max) * 88 : 0}%` }} />)}
      </div>
      <div className="tl-past" style={{ width: `${nowAt}%` }} />
      <div className="tl-ruler">
        {hourMarks(campus).map(({ h, label }) => (
          <span key={h} className={cx("tl-h", label && "major")} style={{ left: `${pct(h * 60)}%` }}>
            {label && <em>{h}</em>}
          </span>
        ))}
      </div>
      {nowIn && <div className="tl-now" style={{ left: `${nowAt}%` }} />}
      <div className="tl-head" style={{ left: `${pct(t)}%` }} />
    </div>
  );
}

export function TimeIsland() {
  const date = useApp((s) => s.date), t = useApp((s) => s.t), live = useApp((s) => s.live);
  const room = useApp((s) => s.room);
  const [open, setOpen] = useState(false);
  const island = useRef<HTMLDivElement>(null);

  // на телефоне остров закрывает низ плана: план поднимается над ним
  useLayoutEffect(() => {
    const el = island.current;
    if (!open || !el || !isPhone()) return;
    const measure = () => {
      const plan = document.getElementById("plan");
      if (!plan) return;
      // по раскладке, а не по экрану: пока остров въезжает, его рамка ещё сдвинута
      const wrap = el.offsetParent as HTMLElement | null;
      const gap = wrap ? wrap.getBoundingClientRect().bottom - plan.getBoundingClientRect().bottom : 0;
      planCtl.current?.setInset(parseFloat(getComputedStyle(el).bottom) + el.offsetHeight + 8 - gap);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => { ro.disconnect(); planCtl.current?.setInset(0); };
  }, [open]);

  // карточка аудитории на телефоне занимает то же место снизу
  useEffect(() => { if (room) setOpen(false); }, [room]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) {
    return (
      <div className={cx("time-pill", !live && "shifted")}>
        <button className="tp-main" onClick={() => setOpen(true)} title="Занятость в другое время">
          {/* часы и крестик всегда в разметке: при возврате к «сейчас» они плавно схлопываются */}
          <span className="tp-clock" aria-hidden="true"><Icon name="clock" /></span>
          <span>{live ? "Сейчас" : relDay(date) || ghostFmt.format(parseIso(date))}</span>
          <b>{fmt(t)}</b>
        </button>
        <button className="tp-x" onClick={goNow} title="Вернуться к текущему времени" tabIndex={live ? -1 : 0} aria-hidden={live}>
          <Icon name="close" />
        </button>
      </div>
    );
  }

  const d = parseIso(date);
  return (
    <div className="time-island" ref={island} role="dialog" aria-label="Занятость аудиторий">
      <div className="ti-head">
        <b>Занятость</b>
        <button className="ti-x" onClick={() => setOpen(false)} title="Свернуть"><Icon name="close" /></button>
      </div>
      <div className="ti-date">
        <button className="icon-btn" title="Предыдущий день" onClick={() => setDate(addDays(date, -1))}><Icon name="back" /></button>
        <label className="ti-day" title="Выбрать дату">
          <span>{relDay(date) || dowFmt.format(d)}, {dayFmt.format(d)}</span>
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </label>
        <button className="icon-btn" title="Следующий день" onClick={() => setDate(addDays(date, 1))}><Icon name="next" /></button>
      </div>
      <div className="ti-time">
        <span className="time-val">{fmt(t)}</span>
        <BusyNote date={date} t={t} />
        <button className={cx("chip-btn", live && "on")} onClick={goNow}>Сейчас</button>
      </div>
      <Timeline date={date} t={t} live={live} />
      <div className="ti-legend">
        <span><i className="sw free" />Свободна</span>
        <span><i className="sw soon" />Скоро пара</span>
        <span><i className="sw busy" />Идёт пара</span>
        <span><i className="sw kitchen" />Кухни, кафе</span>
        <span><i className="sw staff" />Сотрудники</span>
      </div>
    </div>
  );
}
