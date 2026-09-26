/* Пары: строка, список с линией «сейчас», свободные аудитории, общее расписание */
import { useState } from "react";
import { CAMPUSES, dataMax, dataMin, eventsOn, evKind, floorNums, roomCampus, roomFloor, roomStatus, updatedAt, type Ev } from "../lib/schedule";
import { useApp, setState } from "../lib/store";
import { closeFreeScreen, openFreeScreen, pickRoom } from "../lib/actions";
import { Icon } from "./icons";
import { cx, dayFmt, fmt, parseIso } from "../lib/util";

// путь от base: на Pages сайт живёт в подпапке, абсолютный /img/... даёт 404
const FLAG = import.meta.env.BASE_URL + "img/free-rooms-flag.png";

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

// Крыло - первая буква аудитории: N/W/S/E в ЦТ, B/F в Дукате
const WING_ORDER = "NWSEBF";
const wingOf = (r: string) => (/^[A-Z]/.test(r) ? r[0] : "·");
const wingRank = (w: string) => { const i = WING_ORDER.indexOf(w); return i < 0 ? 99 : i; };

type FreeRoom = { r: string; st: string; until: number | null };

// Свободные аудитории кампуса в выбранное время: этажи, внутри по крыльям
function freeRooms(campusId: string, date: string, t: number) {
  let total = 0, free = 0;
  const floors = floorNums(CAMPUSES[campusId]).map((n) => {
    const rooms = Object.keys(roomFloor).filter((r) => roomCampus[r] === campusId && roomFloor[r] === n);
    total += rooms.length;
    let nFree = 0;
    const wings = new Map<string, FreeRoom[]>();
    for (const r of rooms.sort((a, b) => wingRank(wingOf(a)) - wingRank(wingOf(b)))) {
      if (!wings.has(wingOf(r))) wings.set(wingOf(r), []);
      const st = roomStatus(r, date, t);
      if (st.st !== "busy") { wings.get(wingOf(r))!.push({ r, st: st.st, until: st.until }); nFree++; }
    }
    free += nFree;
    for (const list of wings.values()) list.sort((a, b) => (b.until ?? 9999) - (a.until ?? 9999) || a.r.localeCompare(b.r, "ru", { numeric: true }));
    return { n, rooms, free: nFree, wings: [...wings] };
  }).filter((f) => f.rooms.length);
  return { floors, total, free };
}

// В списке пар - одна строка со сводкой, сам список на отдельном экране
function FreeRoomsCard() {
  const campusId = useApp((s) => s.campus);
  const date = useApp((s) => s.date), t = useApp((s) => s.t), live = useApp((s) => s.live);
  if (outOfRange(date)) return null;
  const { floors, total, free } = freeRooms(campusId, date, t);
  if (!floors.length) return null;
  const best = floors.reduce((a, b) => (b.free > a.free ? b : a));
  return (
    <button className="free-card" onClick={openFreeScreen}>
      <img className="fc-ic" src={FLAG} alt="" />
      <span className="fc-text">
        <b>Свободные аудитории</b>
        <small>
          {[live ? "сейчас" : `в ${fmt(t)}`, free ? `больше всего на ${best.n} этаже` : "всё занято"].join(" · ")}
        </small>
      </span>
      <span className="fc-n">{free}<small>/{total}</small></span>
      <Icon name="next" />
    </button>
  );
}

export function FreeScreen() {
  const campusId = useApp((s) => s.campus);
  const date = useApp((s) => s.date), t = useApp((s) => s.t);
  const { floors, total, free } = freeRooms(campusId, date, t);
  return (
    <section className="free-screen">
      <div className="rt-head">
        <button className="rt-close" onClick={closeFreeScreen}><Icon name="back" />Пары</button>
        <h2>Свободные аудитории</h2>
      </div>
      {outOfRange(date) ? <NoData /> : (
        <div className="free-rooms">
          <h3 className="block-title">Свободны в {fmt(t)} · {free} из {total}</h3>
          {floors.map(({ n, wings }) => (
            <div key={n} className="fr-floor">
              <div className="fr-n">{n}<small>этаж</small></div>
              <div className="fr-wings">
                {wings.map(([w, list]) => (
                  <div key={w} className="fr-wing">
                    <span className="fr-w" title={w === "·" ? "Другие" : `Крыло ${w}`}>{w}</span>
                    <div className="free-chips">
                      {list.length ? list.map((x) => (
                        <button key={x.r} className={cx("free-chip", x.st)} onClick={() => pickRoom(x.r)}
                          title={x.until ? `Свободна до ${fmt(x.until)}` : "Свободна до конца дня"}>
                          {x.r}{x.until && <small>до {fmt(x.until)}</small>}
                        </button>
                      )) : <span className="fr-none">всё занято</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      <DataStamp />
    </section>
  );
}

// Общее расписание кампуса: не зависит от того, что выбрано на плане
export function AllSchedule() {
  const campusId = useApp((s) => s.campus);
  const date = useApp((s) => s.date), t = useApp((s) => s.t);
  const query = useApp((s) => s.query);
  const q = query.trim().toLowerCase();
  let evs = eventsOn(date).filter((e) => e.campus === campusId);
  if (q) evs = evs.filter((e) => e.search.includes(q));
  return (
    <div className="all-part">
      <FreeRoomsCard />
      <div className="list-head">
        <h2>Пары · {evs.length}</h2>
      </div>
      <input className="search" type="search" placeholder="Поиск: предмет, преподаватель, поток"
        value={query} onChange={(e) => setState({ query: e.target.value })} />
      <EventList evs={evs} t={t} empty="Пар нет" />
      <DataStamp />
    </div>
  );
}
