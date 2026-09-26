/* Пары: строка, список с линией «сейчас», свободные аудитории, общее расписание */
import { useState } from "react";
import { CAMPUSES, dataMax, dataMin, eventsOn, evKind, floorNums, roomCampus, roomFloor, roomStatus, updatedAt, type Ev } from "../lib/schedule";
import { useApp, setState } from "../lib/store";
import { pickRoom } from "../lib/actions";
import { cx, dayFmt, fmt, parseIso } from "../lib/util";
import { Seg } from "./Seg";

export function RoomChip({ room, sel }: { room: string; sel?: boolean }) {
  return <button className={cx("room", sel && "sel")} onClick={() => pickRoom(room)} title="Показать на плане">{room}</button>;
}

// Одна пара, как в общем списке: время, название, аудитории, тип, преподаватели
export function EventRow({ e, t, room, as = "li" }: { e: Ev; t: number; room?: string | null; as?: "li" | "div" }) {
  const cls = e.e <= t ? "past" : e.s <= t ? "now" : "";
  const meta = [e.teachers, e.stream].filter(Boolean).join(" · ");
  const Tag = as;
  return (
    <Tag className={cx("ev", cls)}>
      <div className="t">{e.start}<span>{e.end}</span></div>
      <div>
        <div className="title">{e.title}</div>
        <div className="meta">
          {e.rooms.map((r) => <RoomChip key={r} room={r} sel={r === room} />)}
          <span className={cx("kind", evKind(e.type))}>{e.type}</span>
          {meta && <span>{meta}</span>}
        </div>
      </div>
    </Tag>
  );
}

// Список пар дня: прошедшие к времени плана сворачиваются, линия этого времени между парами
export function EventList({ evs, t, room, empty }: { evs: Ev[]; t: number; room?: string | null; empty: string }) {
  const [showPast, setShowPast] = useState(false);
  if (!evs.length) return <ol className="events"><li className="empty">{empty}</li></ol>;
  const now = t;
  const past = evs.filter((e) => e.e <= now);
  const canHide = past.length > 0 && past.length < evs.length;
  const hidePast = canHide && !showPast;
  let lineDone = false;
  const items = [];
  if (canHide) {
    items.push(<li key="past"><button className="past-toggle" onClick={() => setShowPast(!showPast)}>{hidePast ? "Показать" : "Скрыть"} прошедшие · {past.length}</button></li>);
  }
  for (const [i, e] of evs.entries()) {
    if (hidePast && e.e <= now) continue;
    if (!lineDone && e.s > now) { items.push(<li key="now" className="now-line">{fmt(now)}</li>); lineDone = true; }
    items.push(<EventRow key={i} e={e} t={now} room={room} />);
  }
  return <ol className="events">{items}</ol>;
}

export function DataStamp() {
  if (!updatedAt) return null;
  const d = new Date(updatedAt);
  return (
    <p className="data-stamp">
      Расписание от {dayFmt.format(d)}, {fmt(d.getHours() * 60 + d.getMinutes())} ·{" "}
      <a href="https://cu-schedule.ru/" target="_blank" rel="noopener">cu-schedule.ru</a>
    </p>
  );
}

export const outOfRange = (date: string) => date < dataMin || date > dataMax;
export function NoData() {
  return <div className="block muted">Расписание загружено на {dayFmt.format(parseIso(dataMin))} – {dayFmt.format(parseIso(dataMax))}. На эту дату данных нет.</div>;
}

// Свободные аудитории кампуса в выбранное время, текущий этаж первым
function FreeRooms() {
  const campusId = useApp((s) => s.campus), floor = useApp((s) => s.floor);
  const date = useApp((s) => s.date), t = useApp((s) => s.t);
  if (outOfRange(date)) return <NoData />;
  const floors = floorNums(CAMPUSES[campusId]).sort((a, b) => (a === floor ? -1 : b === floor ? 1 : a - b));
  return (
    <div className="block">
      <h3 className="block-title">Свободны в {fmt(t)}</h3>
      {floors.map((n) => {
        const rooms = Object.keys(roomFloor).filter((r) => roomCampus[r] === campusId && roomFloor[r] === n);
        if (!rooms.length) return null;
        const free = rooms.map((r) => ({ r, ...roomStatus(r, date, t) }))
          .filter((x) => x.st !== "busy")
          .sort((a, b) => (b.until ?? 9999) - (a.until ?? 9999) || a.r.localeCompare(b.r));
        return (
          <div key={n}>
            <div className="muted" style={{ margin: "6px 0 5px" }}>{n} этаж · {free.length} из {rooms.length}</div>
            <div className="free-chips">
              {free.length ? free.map((x) => (
                <button key={x.r} className={cx("free-chip", x.st)} onClick={() => pickRoom(x.r)}>
                  {x.r}<small>{x.until ? "до " + fmt(x.until) : "весь день"}</small>
                </button>
              )) : <span className="muted">всё занято</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Общее расписание кампуса: не зависит от того, что выбрано на плане
export function AllSchedule() {
  const campusId = useApp((s) => s.campus), floor = useApp((s) => s.floor);
  const date = useApp((s) => s.date), t = useApp((s) => s.t);
  const scope = useApp((s) => s.scope), query = useApp((s) => s.query);
  const q = query.trim().toLowerCase();
  let evs = eventsOn(date).filter((e) => e.campus === campusId);
  if (scope === "floor") evs = evs.filter((e) => e.rooms.some((r) => roomFloor[r] === floor));
  if (q) evs = evs.filter((e) => e.search.includes(q));
  return (
    <div className="all-part">
      <FreeRooms />
      <div className="list-head">
        <h2>Пары · {evs.length}</h2>
        <Seg className="small" value={scope} onChange={(v) => setState({ scope: v })}
          items={[{ value: "all", label: "Весь кампус" }, { value: "floor", label: "Этот этаж" }]} />
      </div>
      <input className="search" type="search" placeholder="Поиск: предмет, преподаватель, поток"
        value={query} onChange={(e) => setState({ query: e.target.value })} />
      <EventList evs={evs} t={t} empty="Пар нет" />
      <DataStamp />
    </div>
  );
}
