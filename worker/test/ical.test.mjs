import test from "node:test";
import assert from "node:assert/strict";
import { parse, serialize, expand, setPartstat, fold, dateProp, prop, props, partstatOf } from "../src/ical.js";
import { parseSummary, toAppEvent } from "../src/timetable.js";
import { parseXml, find, findAll, text } from "../src/xml.js";

const ME = "a.sukhanov@edu.centraluniversity.ru";

// Как у Яндекса: серия + замены по RECURRENCE-ID (онлайн, другая аудитория, другое время)
const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Yandex LLC//Yandex Calendar//EN",
  "BEGIN:VEVENT",
  "DTSTAMP:20260901T000000Z",
  "UID:sem-1@yandex",
  "SEQUENCE:3",
  "DTSTART:20260910T143000Z",
  "DTEND:20260910T155000Z",
  "SUMMARY:Чёрное зеркало: кино и теория медиа\\, Семинар\\, S305 (ЦТ)",
  "DESCRIPTION:https://centraluniversity.ktalk.ru/08df02af312c7124ee514e0001023118",
  "ORGANIZER;CN=Расписание:mailto:timetable@centraluniversity.ru",
  "ATTENDEE;PARTSTAT=NEEDS-ACTION;CN=\"Суханов, Артём\";RSVP=TRUE:mailto:A.Sukhanov@edu.centraluniversity.ru",
  "ATTENDEE;PARTSTAT=ACCEPTED;CN=Кто-то:mailto:other@edu.centraluniversity.ru",
  "RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20261220T153000Z;INTERVAL=1",
  "EXDATE:20261008T143000Z",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTAMP:20260901T000000Z",
  "UID:sem-1@yandex",
  "RECURRENCE-ID:20260910T143000Z",
  "DTSTART:20260910T143000Z",
  "DTEND:20260910T155000Z",
  "SUMMARY:Чёрное зеркало: кино и теория медиа\\, Семинар\\, Онлайн",
  "ORGANIZER:mailto:timetable@centraluniversity.ru",
  "ATTENDEE;PARTSTAT=ACCEPTED:mailto:a.sukhanov@edu.centraluniversity.ru",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTAMP:20260901T000000Z",
  "UID:sem-1@yandex",
  "RECURRENCE-ID:20260917T143000Z",
  "DTSTART:20260917T160000Z",
  "DTEND:20260917T172000Z",
  "SUMMARY:Чёрное зеркало: кино и теория медиа\\, Семинар\\, N318 (ЦТ)",
  "ORGANIZER:mailto:timetable@centraluniversity.ru",
  "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:a.sukhanov@edu.centraluniversity.ru",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

const utc = (s) => Date.parse(s);

test("серия разворачивается с заменами и исключениями", () => {
  const cal = parse(ICS);
  const inst = expand(cal, utc("2026-09-07T00:00:00Z"), utc("2026-10-19T00:00:00Z"));
  const rows = inst.map((i) => [new Date(i.start.utc).toISOString().slice(0, 16), parseSummary(prop(i.event, "SUMMARY").value.replace(/\\,/g, ",")).rooms.join("+") || "online"]);
  assert.deepEqual(rows, [
    ["2026-09-10T14:30", "online"],
    ["2026-09-17T16:00", "N318"], // перенос времени и аудитории
    ["2026-09-24T14:30", "S305"],
    ["2026-10-01T14:30", "S305"],
    // 08.10 отменено через EXDATE
    ["2026-10-15T14:30", "S305"],
  ]);
  assert.equal(inst[1].recurrenceId, utc("2026-09-17T14:30:00Z"));
});

test("UNTIL ограничивает серию", () => {
  const inst = expand(parse(ICS), utc("2026-12-01T00:00:00Z"), utc("2027-02-01T00:00:00Z"));
  assert.deepEqual(inst.map((i) => new Date(i.start.utc).toISOString().slice(0, 10)), ["2026-12-03", "2026-12-10", "2026-12-17"]);
});

test("серия с TZID считается в своём поясе", () => {
  const ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART;TZID=Europe/Moscow:20260907T173000\r\nDTEND;TZID=Europe/Moscow:20260907T185000\r\nRRULE:FREQ=WEEKLY;COUNT=2\r\nSUMMARY:A\r\nEND:VEVENT\r\nEND:VCALENDAR";
  const inst = expand(parse(ics), 0, utc("2030-01-01T00:00:00Z"));
  assert.deepEqual(inst.map((i) => new Date(i.start.utc).toISOString()), ["2026-09-07T14:30:00.000Z", "2026-09-14T14:30:00.000Z"]);
  assert.equal(inst[0].end - inst[0].start.utc, 80 * 60000);
});

test("название пары разбирается на предмет, тип и аудитории", () => {
  assert.deepEqual(parseSummary("Системный анализ, Семинар, B214 + B216 (Дукат)"),
    { title: "Системный анализ", type: "Семинар", rooms: ["B214", "B216"], campus: "DUCAT", campusName: "Дукат", online: false });
  assert.deepEqual(parseSummary("Разработка на Java, Лекция, Онлайн"),
    { title: "Разработка на Java", type: "Лекция", rooms: [], campus: null, online: true });
  assert.equal(parseSummary("Выбор: как принимать решения, Семинар, S304 (ЦТ)").campus, "CT");
  assert.equal(parseSummary("Созвон с командой").title, "Созвон с командой");
});

test("событие для приложения: ссылка на звонок и мой статус", () => {
  const cal = parse(ICS);
  const [first, , third] = expand(cal, utc("2026-09-07T00:00:00Z"), utc("2026-10-01T00:00:00Z"));
  const a = toAppEvent(first, { href: "/calendars/me/events-1/sem-1.ics", emails: [ME] });
  assert.equal(a.online, true);
  assert.equal(a.partstat, "ACCEPTED");
  assert.equal(a.url, "https://centraluniversity.ktalk.ru/08df02af312c7124ee514e0001023118"); // у замены нет описания: ссылка серии
  const c = toAppEvent(third, { href: "/x.ics", emails: [ME] });
  assert.equal(c.url, "https://centraluniversity.ktalk.ru/08df02af312c7124ee514e0001023118");
  assert.equal(c.partstat, "NEEDS-ACTION"); // адрес в разном регистре всё равно находится
  assert.deepEqual(c.rooms, ["S305"]);
  assert.equal(c.timetable, true);
});

test("отметка одного занятия создаёт замену и не трогает серию", () => {
  const cal = parse(ICS);
  const rid = utc("2026-09-24T14:30:00Z");
  assert.equal(setPartstat(cal, { uid: "sem-1@yandex", recurrenceId: rid, scope: "one", emails: [ME], partstat: "ACCEPTED" }), 1);
  const back = parse(serialize(cal));
  const evs = back.children.filter((c) => c.name === "VEVENT");
  assert.equal(evs.length, 4);
  const ov = evs.find((e) => dateProp(e, "RECURRENCE-ID")?.utc === rid);
  assert.ok(ov, "замена появилась");
  assert.equal(prop(ov, "DTSTART").value, "20260924T143000Z");
  assert.equal(prop(ov, "DTEND").value, "20260924T155000Z");
  assert.equal(prop(ov, "RRULE"), undefined);
  assert.equal(prop(ov, "EXDATE"), undefined);
  assert.equal(partstatOf(ov, [ME]), "ACCEPTED");
  assert.equal(partstatOf(evs[0], [ME]), "NEEDS-ACTION", "серия не изменилась");
  // чужой статус и остальные поля на месте
  assert.equal(props(ov, "ATTENDEE").length, 2);
  assert.equal(prop(ov, "SEQUENCE").value, "3");
  // после записи развёртка видит новую замену
  const inst = expand(back, rid, rid + 1);
  assert.equal(partstatOf(inst[0].event, [ME]), "ACCEPTED");
});

test("отметка существующей замены меняет только её", () => {
  const cal = parse(ICS);
  const rid = utc("2026-09-17T14:30:00Z");
  setPartstat(cal, { uid: "sem-1@yandex", recurrenceId: rid, scope: "one", emails: [ME], partstat: "DECLINED" });
  const evs = cal.children.filter((c) => c.name === "VEVENT");
  assert.equal(evs.length, 3);
  assert.equal(partstatOf(evs[2], [ME]), "DECLINED");
  assert.equal(partstatOf(evs[0], [ME]), "NEEDS-ACTION");
});

test("отметка всей серии меняет серию и будущие замены", () => {
  const cal = parse(ICS);
  const n = setPartstat(cal, { uid: "sem-1@yandex", recurrenceId: utc("2026-09-24T14:30:00Z"), scope: "series", emails: [ME], partstat: "TENTATIVE", nowUtc: utc("2026-09-15T00:00:00Z") });
  assert.equal(n, 2); // серия + замена 17.09; прошедшая замена 10.09 не трогается
  const evs = cal.children.filter((c) => c.name === "VEVENT");
  assert.deepEqual(evs.map((e) => partstatOf(e, [ME])), ["TENTATIVE", "ACCEPTED", "TENTATIVE"]);
  const me = props(evs[0], "ATTENDEE")[0];
  assert.ok(!me.params.some(([k]) => k === "RSVP"), "RSVP снят после ответа");
  assert.match(serialize(cal), /CN="Суханов, Артём"/, "параметр с запятой остался в кавычках");
});

test("если меня нет среди участников, ничего не меняется", () => {
  const cal = parse(ICS);
  const before = serialize(cal);
  assert.equal(setPartstat(cal, { uid: "sem-1@yandex", recurrenceId: null, scope: "series", emails: ["nobody@x.ru"], partstat: "ACCEPTED" }), 0);
  assert.equal(serialize(cal), before);
});

test("нетронутые строки сохраняются байт в байт", () => {
  // исходник как его отдал бы сервер: длинные строки уже перенесены
  const wire = ICS.split("\r\n").map(fold).join("\r\n");
  assert.equal(serialize(parse(wire)), wire);
});

test("длинные строки переносятся по 75 байт", () => {
  const line = "DESCRIPTION:" + "Кириллица занимает два байта. ".repeat(10);
  const folded = fold(line);
  for (const l of folded.split("\r\n")) assert.ok(new TextEncoder().encode(l).length <= 75);
  assert.equal(folded.replace(/\r\n /g, ""), line);
});

test("XML ответа CalDAV: префиксы, атрибуты, CDATA", () => {
  const xml = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
    <D:response><D:href>/calendars/me/events-1/</D:href><D:propstat><D:prop>
      <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
      <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
      <D:displayname>Мои события</D:displayname></D:prop></D:propstat></D:response>
    <D:response><D:href>/calendars/me/e.ics</D:href><D:propstat><D:prop>
      <C:calendar-data><![CDATA[BEGIN:VCALENDAR
END:VCALENDAR]]></C:calendar-data><D:getetag>"1&amp;2"</D:getetag></D:prop></D:propstat></D:response>
  </D:multistatus>`;
  const root = parseXml(xml);
  const [a, b] = findAll(root, "response");
  assert.equal(text(find(a, "displayname")), "Мои события");
  assert.ok(find(find(a, "resourcetype"), "calendar"));
  assert.equal(find(a, "comp").attrs.name, "VEVENT");
  assert.match(text(find(b, "calendar-data")), /^BEGIN:VCALENDAR/);
  assert.equal(text(find(b, "getetag")), '"1&2"');
});
