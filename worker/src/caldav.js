// Клиент CalDAV Яндекс Календаря. Способ входа (пароль приложения или OAuth)
// сюда приходит готовым заголовком Authorization, остальное от него не зависит.

import { parseXml, find, findAll, text } from "./xml.js";

export const CALDAV_BASE = "https://caldav.yandex.ru";

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/"';

const utcStamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

export class CalDav {
  constructor(authorization, base) {
    this.authorization = authorization;
    this.base = base || CALDAV_BASE;
  }

  async request(method, path, { body, depth, headers = {} } = {}) {
    const url = new URL(path, this.base);
    if (url.origin !== new URL(this.base).origin) throw new HttpError(400, "bad_href");
    const res = await fetch(url, {
      method,
      body,
      headers: {
        Authorization: this.authorization,
        ...(body && { "Content-Type": method === "PUT" ? "text/calendar; charset=utf-8" : "application/xml; charset=utf-8" }),
        ...(depth != null && { Depth: String(depth) }),
        ...headers,
      },
      redirect: "manual",
    });
    // 403 не разлогинивает: так Яндекс отвечает и на запрет правки конкретного события
    if (res.status === 401) throw new HttpError(401, "auth", "Яндекс не принял логин или пароль");
    if (res.status === 403) throw new HttpError(403, "forbidden", `Яндекс запретил ${method}`);
    return res;
  }

  async xml(method, path, body, depth) {
    const res = await this.request(method, path, { body, depth });
    if (res.status !== 207 && !res.ok) throw new HttpError(502, "upstream", `CalDAV ${method} ${res.status}`);
    return parseXml(await res.text());
  }

  propfind(path, propXml, depth = 0) {
    return this.xml("PROPFIND", path, `<?xml version="1.0" encoding="utf-8"?><d:propfind ${NS}><d:prop>${propXml}</d:prop></d:propfind>`, depth);
  }

  /** Кто вошёл и где его календари */
  async discover() {
    const root = await this.propfind("/", "<d:current-user-principal/>");
    const principal = text(find(find(root, "current-user-principal") || root, "href"));
    if (!principal) throw new HttpError(502, "upstream", "CalDAV не вернул principal");
    const p = await this.propfind(principal, "<c:calendar-home-set/><c:calendar-user-address-set/><d:displayname/>");
    const home = text(find(find(p, "calendar-home-set") || p, "href"));
    if (!home) throw new HttpError(502, "upstream", "CalDAV не вернул calendar-home-set");
    const emails = findAll(find(p, "calendar-user-address-set") || { children: [] }, "href")
      .map((h) => text(h).replace(/^mailto:/i, "").toLowerCase())
      .filter((e) => e.includes("@"));
    return { principal, home, emails, name: text(find(p, "displayname")) };
  }

  /** Календари с событиями и их метки изменений */
  async calendars(home) {
    const res = await this.propfind(home, "<d:displayname/><d:resourcetype/><cs:getctag/><d:sync-token/><c:supported-calendar-component-set/>", 1);
    const out = [];
    for (const r of findAll(res, "response")) {
      const type = find(r, "resourcetype");
      if (!type || !find(type, "calendar")) continue;
      // календарь только для задач («Не забыть») пропускаем
      const comps = findAll(find(r, "supported-calendar-component-set") || { children: [] }, "comp").map((c) => (c.attrs.name || "").toUpperCase());
      if (comps.length && !comps.includes("VEVENT")) continue;
      out.push({
        href: text(find(r, "href")),
        name: text(find(r, "displayname")),
        ctag: text(find(r, "getctag")) || text(find(r, "sync-token")),
      });
    }
    return out;
  }

  /** Объекты календаря, у которых есть события в интервале */
  async objects(calendarHref, fromUtc, toUtc) {
    const body = `<?xml version="1.0" encoding="utf-8"?><c:calendar-query ${NS}><d:prop><d:getetag/><c:calendar-data/></d:prop>`
      + `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">`
      + `<c:time-range start="${utcStamp(fromUtc)}" end="${utcStamp(toUtc)}"/>`
      + `</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
    const res = await this.xml("REPORT", calendarHref, body, 1);
    return findAll(res, "response")
      .map((r) => ({ href: text(find(r, "href")), etag: text(find(r, "getetag")), ics: text(find(r, "calendar-data")) }))
      .filter((o) => o.ics);
  }

  async get(href) {
    const res = await this.request("GET", href);
    if (res.status === 404) throw new HttpError(404, "not_found", "Событие не найдено");
    if (!res.ok) throw new HttpError(502, "upstream", `CalDAV GET ${res.status}`);
    return { ics: await res.text(), etag: res.headers.get("ETag") };
  }

  /** true - сохранено, false - событие успело измениться (412) */
  async put(href, ics, etag) {
    const res = await this.request("PUT", href, { body: ics, headers: etag ? { "If-Match": etag } : {} });
    if (res.status === 412) return false;
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new HttpError(502, "upstream", `CalDAV PUT ${res.status} ${detail}`);
    }
    return true;
  }
}
