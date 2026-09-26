/* Мои пары из календаря, дополненные общей базой */
import { account, type MyEvent } from "./account";
import { eventsOn, roomFloor } from "./schedule";
import { norm } from "./util";

export type MyEv = MyEvent & { teachers: string; stream: string; known: string[] };

// Преподавателей и поток в календаре нет: берём из общей базы по дате, времени и предмету
const extras = new Map<string, { teachers: string; stream: string; known: string[] }>();
function enrich(ev: MyEvent): MyEv {
  const key = `${ev.date}|${ev.startHM}|${ev.title}|${ev.rooms.join()}`;
  if (!extras.has(key)) {
    const cands = eventsOn(ev.date).filter((c) => c.start === ev.startHM && norm(c.title) === norm(ev.title));
    const hit = cands.find((c) => c.rooms.some((r) => ev.rooms.includes(r))) || (cands.length === 1 ? cands[0] : null);
    extras.set(key, { teachers: hit ? hit.teachers : "", stream: hit ? hit.stream : "", known: ev.rooms.filter((r) => roomFloor[r]) });
  }
  // статус отметки меняется, поэтому берём его из свежего события, а не из кэша
  return { ...ev, ...extras.get(key)! };
}

export const myEvents = (date: string): MyEv[] => (account.user ? account.eventsOn(date).map(enrich) : []);

// аудитория -> мои пары в ней (кроме тех, куда я не иду)
export function myRooms(date: string) {
  const out = new Map<string, MyEv[]>();
  for (const ev of myEvents(date)) {
    if (ev.partstat === "DECLINED") continue;
    for (const r of ev.known) (out.get(r) || out.set(r, []).get(r)!).push(ev);
  }
  return out;
}
