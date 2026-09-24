// Сквозной тест API против поддельного CalDAV-сервера, который ведёт себя как Яндекс:
// principal -> calendar-home -> календари -> REPORT с целыми сериями, GET/PUT с ETag.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import worker from "../src/index.js";
import { parse, dateProp, partstatOf } from "../src/ical.js";

const ME = "student@edu.centraluniversity.ru";
const HOME = "/calendars/student%40edu.centraluniversity.ru/";
const CAL = HOME + "events-1/";
const HREF = CAL + "sem-1.ics";
const AUTH = "Basic " + Buffer.from(`${ME}:app-pass`).toString("base64");

const ICS = [
  "BEGIN:VCALENDAR", "VERSION:2.0",
  "BEGIN:VEVENT", "UID:sem-1", "DTSTAMP:20260901T000000Z",
  "DTSTART:20260924T143000Z", "DTEND:20260924T155000Z",
  "SUMMARY:Чёрное зеркало\\, Семинар\\, S305 (ЦТ)",
  "DESCRIPTION:https://centraluniversity.ktalk.ru/abc",
  "ORGANIZER:mailto:timetable@centraluniversity.ru",
  "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:" + ME,
  "RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20261220T153000Z",
  "END:VEVENT", "END:VCALENDAR", "",
].join("\r\n");

function fakeYandex() {
  const store = { ics: ICS, etag: '"v1"', ctag: "c1", puts: 0, raceOnce: false };
  const ms = (inner) => `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">${inner}</D:multistatus>`;
  const resp = (href, props) => `<D:response><D:href>${href}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    if (req.headers.authorization !== AUTH) { res.writeHead(401); return res.end(); }
    const send = (status, text, headers = {}) => { res.writeHead(status, headers); res.end(text); };
    const url = decodeURIComponent(req.url);
    if (req.method === "PROPFIND" && req.url === "/") return send(207, ms(resp("/", `<D:current-user-principal><D:href>/principals/users/${ME}/</D:href></D:current-user-principal>`)));
    if (req.method === "PROPFIND" && url.startsWith("/principals/")) {
      return send(207, ms(resp(req.url, `<C:calendar-home-set><D:href>${HOME}</D:href></C:calendar-home-set><C:calendar-user-address-set><D:href>mailto:${ME}</D:href></C:calendar-user-address-set><D:displayname>Студент</D:displayname>`)));
    }
    if (req.method === "PROPFIND" && req.url === HOME) {
      return send(207, ms(
        resp(HOME, "<D:resourcetype><D:collection/></D:resourcetype>")
        + resp(CAL, `<D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>Мои события</D:displayname><CS:getctag>${store.ctag}</CS:getctag><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>`)
        + resp(HOME + "todos-1/", `<D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>Не забыть</D:displayname><C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>`)));
    }
    if (req.method === "REPORT" && req.url === CAL) {
      assert.match(body, /time-range start="\d{8}T\d{6}Z"/);
      return send(207, ms(resp(HREF, `<D:getetag>${store.etag}</D:getetag><C:calendar-data>${esc(store.ics)}</C:calendar-data>`)));
    }
    if (req.method === "GET" && req.url === HREF) return send(200, store.ics, { ETag: store.etag });
    if (req.method === "PUT" && req.url === HREF) {
      if (req.headers["if-match"] !== store.etag) return send(412, "");
      if (store.raceOnce) { store.raceOnce = false; store.etag = '"race"'; return send(412, ""); }
      store.puts++;
      store.ics = body; store.etag = `"v${store.puts + 1}"`; store.ctag = `c${store.puts + 1}`;
      return send(204, "", { ETag: store.etag });
    }
    send(404, "");
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, store, base: `http://127.0.0.1:${server.address().port}` })));
}

async function call(env, method, path, { token, body } = {}) {
  const res = await worker.fetch(new Request("http://api" + path, {
    method,
    headers: { "Content-Type": "application/json", Origin: "https://stakancheck.github.io", ...(token && { Authorization: "Bearer " + token }) },
    body: body && JSON.stringify(body),
  }), env);
  return { status: res.status, cors: res.headers.get("Access-Control-Allow-Origin"), data: await res.json() };
}

test("вход, события, ctag и отметка присутствия", async () => {
  const { server, store, base } = await fakeYandex();
  const env = { CALDAV_BASE: base, SESSION_KEY: crypto.randomBytes(32).toString("base64"), ALLOWED_ORIGINS: "https://stakancheck.github.io" };
  try {
    const bad = await call(env, "POST", "/v1/session", { body: { provider: "caldav", login: ME, password: "wrong" } });
    assert.equal(bad.status, 401);
    assert.equal(bad.data.error, "auth");

    const login = await call(env, "POST", "/v1/session", { body: { provider: "caldav", login: ME.toUpperCase(), password: "app-pass" } });
    assert.equal(login.status, 200, JSON.stringify(login.data));
    assert.equal(login.cors, "https://stakancheck.github.io");
    assert.equal(login.data.user.email, ME);
    assert.equal(login.data.user.name, "Студент");
    assert.ok(!JSON.stringify(login.data).includes("app-pass"), "пароль не виден в ответе");
    const token = login.data.token;

    const ev = await call(env, "GET", "/v1/events?from=2026-09-21&to=2026-10-04", { token });
    assert.equal(ev.status, 200, JSON.stringify(ev.data));
    assert.equal(ev.data.ctag, "c1");
    assert.deepEqual(ev.data.events.map((e) => e.start), ["2026-09-24T14:30:00.000Z", "2026-10-01T14:30:00.000Z"]);
    const [first, second] = ev.data.events;
    assert.deepEqual([first.title, first.type, first.rooms, first.campus], ["Чёрное зеркало", "Семинар", ["S305"], "CT"]);
    assert.equal(first.url, "https://centraluniversity.ktalk.ru/abc");
    assert.equal(first.partstat, "NEEDS-ACTION");
    assert.equal(first.calendar, "Мои события");

    const same = await call(env, "GET", "/v1/events?from=2026-09-21&to=2026-10-04&since=c1", { token });
    assert.deepEqual(same.data, { unchanged: true, ctag: "c1" });

    // Отметка одного занятия; сервер один раз сообщает о гонке версий
    store.raceOnce = true;
    const r = await call(env, "POST", "/v1/rsvp", { token, body: { href: second.href, uid: second.uid, recurrenceId: second.recurrenceId, scope: "one", partstat: "ACCEPTED" } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(store.puts, 1);
    const saved = parse(store.ics).children.filter((c) => c.name === "VEVENT");
    assert.equal(saved.length, 2);
    assert.equal(dateProp(saved[1], "RECURRENCE-ID").utc, Date.parse("2026-10-01T14:30:00Z"));
    assert.equal(partstatOf(saved[1], [ME]), "ACCEPTED");
    assert.equal(partstatOf(saved[0], [ME]), "NEEDS-ACTION");

    const after = await call(env, "GET", "/v1/events?from=2026-09-21&to=2026-10-04&since=c1", { token });
    assert.deepEqual(after.data.events.map((e) => e.partstat), ["NEEDS-ACTION", "ACCEPTED"]);

    const outside = await call(env, "POST", "/v1/rsvp", { token, body: { href: "/calendars/other/x.ics", uid: "x", scope: "one", partstat: "ACCEPTED" } });
    assert.equal(outside.status, 400);
    const traversal = await call(env, "POST", "/v1/rsvp", { token, body: { href: HOME + "../other/x.ics", uid: "x", scope: "one", partstat: "ACCEPTED" } });
    assert.equal(traversal.status, 400);

    const forged = await call(env, "GET", "/v1/events?from=2026-09-21&to=2026-10-04", { token: token.slice(0, -4) + "AAAA" });
    assert.equal(forged.status, 401);
    assert.equal(forged.data.error, "session");
  } finally {
    server.close();
  }
});

test("чужой сайт не получает CORS", async () => {
  const env = { SESSION_KEY: crypto.randomBytes(32).toString("base64"), ALLOWED_ORIGINS: "https://stakancheck.github.io" };
  const res = await worker.fetch(new Request("http://api/v1/health", { headers: { Origin: "https://evil.example" } }), env);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
});
