/* Выбранная аудитория: карточка с занятостью, мини-карточка на плане (телефон),
   отдельный экран с расписанием аудитории */
import { CAMPUSES, dayRange, eventsOn, hourMarks, freeWindows, occupancy, roomCampus, roomFloor, roomStatus, type Status } from "../lib/schedule";
import { useApp } from "../lib/store";
import { closeRoomScreen, openRoomScreen, openRoute, selectRoom } from "../lib/actions";
import { useAccountVersion } from "../lib/account";
import { myRooms } from "../lib/mine";
import { cx, fmt, isPhone } from "../lib/util";
import { DataStamp, EventList, EventRow, NoData, outOfRange } from "./Events";
import { Icon } from "./icons";

export function statusText(st: Status) {
  if (st.st === "busy") return `Занята до ${fmt(st.until!)}`;
  return st.until ? `Свободна до ${fmt(st.until)}` : "Свободна до конца дня";
}
export const StatusPill = ({ st }: { st: Status }) => <span className={cx("status-pill", st.st)}>{statusText(st)}</span>;
const where = (room: string) => `${roomFloor[room]} этаж · ${CAMPUSES[roomCampus[room]].short}`;

// Полоса дня в часы работы кампуса: занятые интервалы и отметка времени плана
export function Timeline({ room, date, t, scale = true }: { room: string; date: string; t: number; scale?: boolean }) {
  const [DAY_START, DAY_END] = dayRange(roomCampus[room]), span = DAY_END - DAY_START;
  const pct = (m: number) => ((Math.min(DAY_END, Math.max(DAY_START, m)) - DAY_START) / span) * 100;
  return (
    <>
      <div className="timeline">
        {(occupancy(date)[room] || []).map((b, i) => (
          <div key={i} className="blk" style={{ left: `${pct(b.s)}%`, width: `${pct(b.e) - pct(b.s)}%` }} title={`${fmt(b.s)}–${fmt(b.e)}`} />
        ))}
        {t >= DAY_START && t <= DAY_END && <div className="now" style={{ left: `${pct(t)}%` }} />}
      </div>
      {scale && <div className="tl-scale">{hourMarks(roomCampus[room]).filter((m) => m.label).map((m) => <span key={m.h}>{String(m.h).padStart(2, "0")}</span>)}</div>}
    </>
  );
}

export function RouteButtons({ room }: { room: string }) {
  return (
    <div className="rc-route">
      <button onClick={() => openRoute({ from: "r:" + room })}>Отсюда</button>
      <button className="on" onClick={() => openRoute({ to: "r:" + room })}><Icon name="route" />Сюда</button>
    </div>
  );
}

// Своя пара в аудитории: ближайшая не закончившаяся, иначе последняя
function useMyPair(room: string, date: string, t: number) {
  useAccountVersion();
  const mine = myRooms(date).get(room) || [];
  return mine.find((e) => e.e > t) || mine[mine.length - 1];
}

export function RoomCard({ room, onClose }: { room: string; onClose?: () => void }) {
  const date = useApp((s) => s.date), t = useApp((s) => s.t);
  const st = roomStatus(room, date, t);
  const wins = freeWindows(room, date);
  return (
    <div className="room-card">
      <div className="top">
        <span className="code">{room}</span>
        <span className="where">{where(room)}</span>
        <StatusPill st={st} />
        {onClose && <button className="close" onClick={onClose} title="Сбросить выбор">×</button>}
      </div>
      <Timeline room={room} date={date} t={t} />
      <div className="windows">Свободные окна: {wins.length ? wins.map(([a, b], i) => <span key={i}>{i ? ", " : ""}<b>{fmt(a)}–{fmt(b)}</b></span>) : "нет"}</div>
      <RouteButtons room={room} />
    </div>
  );
}

// Телефон: карточка выбранной аудитории поверх плана
export function RoomPeek() {
  const room = useApp((s) => s.room), date = useApp((s) => s.date), t = useApp((s) => s.t);
  const my = useMyPair(room || "", date, t);
  if (!room) return null;
  const st = roomStatus(room, date, t);
  const evs = eventsOn(date).filter((e) => e.rooms.includes(room));
  // что сейчас идёт, иначе что будет дальше
  const cur = evs.find((e) => e.s <= t && t < e.e), next = evs.find((e) => e.s > t);
  const shown = cur || next;
  const left = evs.filter((e) => e.e > t).length;
  return (
    <div className="room-peek">
      <div className="pk-head">
        <b>{room}</b>
        <span className="pk-where">{where(room)}</span>
        <StatusPill st={st} />
        <button className="pk-x" onClick={() => selectRoom(null)} title="Сбросить выбор"><Icon name="close" /></button>
      </div>
      {outOfRange(date) ? <p className="pk-empty">На эту дату расписания нет</p> : shown ? (
        <div className="pk-ev">
          <div className="pk-label">{cur ? "Сейчас" : `Дальше в ${shown.start}`}{left > 1 ? ` · потом ещё ${left - 1}` : ""}</div>
          <EventRow e={shown} t={t} room={room} as="div" />
        </div>
      ) : <p className="pk-empty">{evs.length ? "Пары в этот день закончились" : "В этот день пар нет, аудитория свободна"}</p>}
      {my && <div className="pk-my">Ваша пара {my.startHM}–{my.endHM} · {my.title}</div>}
      <Timeline room={room} date={date} t={t} scale={false} />
      <div className="pk-actions">
        <button className="pk-sched" onClick={openRoomScreen}><Icon name="list" />Расписание</button>
        <button className="pk-from" onClick={() => openRoute({ from: "r:" + room })}>Отсюда</button>
        <button className="pk-to" onClick={() => openRoute({ to: "r:" + room })}><Icon name="route" />Сюда</button>
      </div>
    </div>
  );
}

// Расписание одной аудитории: на телефоне отдельный экран, на компьютере в правой колонке
export function RoomScreen() {
  const room = useApp((s) => s.room), date = useApp((s) => s.date), t = useApp((s) => s.t);
  const my = useMyPair(room || "", date, t);
  if (!room) return null;
  const evs = eventsOn(date).filter((e) => e.rooms.includes(room));
  // на телефоне возвращаемся к плану с выбранной аудиторией, на компьютере снимаем выбор
  const phone = isPhone();
  const back = () => (phone ? closeRoomScreen() : selectRoom(null));
  return (
    <section className="room-screen">
      <div className="rt-head">
        <button className="rt-close" onClick={back}><Icon name="back" />{phone ? "План" : "Все пары"}</button>
        <h2>Аудитория {room}</h2>
      </div>
      <RoomCard room={room} />
      {my && <div className="pk-my room-my">Ваша пара {my.startHM}–{my.endHM} · {my.title}</div>}
      <div className="list-head"><h2>Пары · {evs.length}</h2></div>
      {outOfRange(date) ? <NoData /> : <EventList evs={evs} t={t} room={room} empty="В этот день пар в аудитории нет, она свободна" />}
      <DataStamp />
    </section>
  );
}
