// Разбор событий из календаря университета в формат приложения.
// Название пары от timetable@centraluniversity.ru устроено так:
//   «Предмет, Тип, B214 + B216 (Дукат)» или «Предмет, Тип, Онлайн».

import { prop, props, param, unescapeText, partstatOf } from "./ical.js";

const CAMPUS = { "цт": "CT", "дукат": "DUCAT" };

export function parseSummary(summary) {
  const s = (summary || "").trim();
  const m = /^(.+),\s*([^,]+),\s*([^,]+)$/.exec(s);
  if (m) {
    const [, title, type, place] = m;
    if (/^онлайн$/i.test(place.trim())) {
      return { title: title.trim(), type: type.trim(), rooms: [], campus: null, online: true };
    }
    const pm = /^(.+?)\s*\(([^)]+)\)$/.exec(place.trim());
    if (pm) {
      const rooms = pm[1].split("+").map((r) => r.trim()).filter(Boolean);
      const campusName = pm[2].trim().toLowerCase();
      return { title: title.trim(), type: type.trim(), rooms, campus: CAMPUS[campusName] || "OTHER", campusName: pm[2].trim(), online: false };
    }
  }
  return { title: s, type: "", rooms: [], campus: null, online: false };
}

const URL_RE = /https?:\/\/[^\s<>"'\\]+/g;
// Сначала ссылки на известные сервисы звонков, потом любые
const MEET_RE = /ktalk\.ru|telemost\.yandex|zoom\.us|meet\.google|teams\.microsoft|jazz\.sber|salutejazz/i;

export function meetingUrl(ev) {
  const texts = [];
  for (const name of ["URL", "CONFERENCE", "X-TELEMOST-CONFERENCE", "LOCATION", "DESCRIPTION"]) {
    for (const p of props(ev, name)) texts.push(unescapeText(p.value));
  }
  const urls = texts.flatMap((t) => t.match(URL_RE) || []).map((u) => u.replace(/[.,;)]+$/, ""));
  return urls.find((u) => MEET_RE.test(u)) || urls[0] || null;
}

const mail = (v) => (v || "").replace(/^mailto:/i, "").toLowerCase();

/** Событие календаря -> объект для приложения */
export function toAppEvent(inst, { href, emails }) {
  const ev = inst.event;
  const summary = unescapeText(prop(ev, "SUMMARY")?.value || "");
  const parsed = parseSummary(summary);
  const organizer = prop(ev, "ORGANIZER");
  const location = unescapeText(prop(ev, "LOCATION")?.value || "").trim();
  return {
    id: `${inst.uid}|${inst.recurrenceId ?? ""}`,
    uid: inst.uid,
    href,
    recurrenceId: inst.recurrenceId,
    recurring: inst.recurring,
    start: new Date(inst.start.utc).toISOString(),
    end: new Date(inst.end).toISOString(),
    allDay: inst.start.allDay,
    summary,
    ...parsed,
    location,
    // у замены ссылки может не быть, тогда берём ссылку серии
    url: meetingUrl(ev) || (inst.master && inst.master !== ev ? meetingUrl(inst.master) : null),
    organizer: organizer ? { email: mail(organizer.value), name: param(organizer, "CN") || "" } : null,
    attendees: props(ev, "ATTENDEE").length,
    partstat: partstatOf(ev, emails),
    timetable: /^timetable@/i.test(mail(organizer?.value)),
  };
}
