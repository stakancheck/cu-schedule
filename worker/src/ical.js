// Разбор и правка iCalendar (RFC 5545) в объёме, который нужен для расписания:
// компоненты и свойства, развёртка повторов (RRULE/EXDATE/RDATE + замены по
// RECURRENCE-ID) и смена статуса участника с сохранением остального текста как есть.

const DAY = 86400000;
export const DEFAULT_TZ = "Europe/Moscow";

/* ============================================================ Разбор */

function unfold(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

function parseLine(line) {
  // имя;парам=значение;парам="в кавычках: можно ;,":значение
  let i = 0, inQ = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === ":" && !inQ) break;
  }
  if (i === line.length) return null;
  const head = line.slice(0, i), value = line.slice(i + 1);
  const parts = [];
  let cur = "";
  inQ = false;
  for (const c of head) {
    if (c === '"') inQ = !inQ;
    if (c === ";" && !inQ) { parts.push(cur); cur = ""; } else cur += c;
  }
  parts.push(cur);
  const params = parts.slice(1).map((p) => {
    const eq = p.indexOf("=");
    const k = (eq < 0 ? p : p.slice(0, eq)).toUpperCase();
    const v = eq < 0 ? "" : p.slice(eq + 1).replace(/^"(.*)"$/, "$1");
    return [k, v];
  });
  return { name: parts[0].toUpperCase(), params, value, raw: line };
}

export function parse(text) {
  const root = { name: "#root", props: [], children: [] };
  const stack = [root];
  for (const line of unfold(text)) {
    if (!line.trim()) continue;
    const p = parseLine(line);
    if (!p) continue;
    const top = stack[stack.length - 1];
    if (p.name === "BEGIN") {
      const c = { name: p.value.toUpperCase(), props: [], children: [] };
      top.children.push(c);
      stack.push(c);
    } else if (p.name === "END") {
      if (stack.length > 1) stack.pop();
    } else top.props.push(p);
  }
  return root.children.find((c) => c.name === "VCALENDAR") || root;
}

export const prop = (comp, name) => comp.props.find((p) => p.name === name);
export const props = (comp, name) => comp.props.filter((p) => p.name === name);
export const param = (p, name) => { const x = p && p.params.find(([k]) => k === name); return x ? x[1] : undefined; };

export function setParam(p, name, value) {
  const x = p.params.find(([k]) => k === name);
  if (x) x[1] = value; else p.params.push([name, value]);
  p.raw = null;
}

export function unescapeText(v) {
  return (v || "").replace(/\\([nN\\;,])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));
}

/* ============================================================ Запись */

function paramValue(v) {
  return /[:;,]/.test(v) ? `"${v}"` : v;
}

function lineOf(p) {
  if (p.raw != null) return p.raw;
  const params = p.params.map(([k, v]) => `;${k}=${paramValue(v)}`).join("");
  return `${p.name}${params}:${p.value}`;
}

// Строки длиннее 75 байт переносятся, продолжение начинается с пробела
const enc = new TextEncoder();
export function fold(line) {
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = "", size = 0, limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (size + n > limit) { out.push(cur); cur = " "; size = 1; limit = 75; }
    cur += ch; size += n;
  }
  out.push(cur);
  return out.join("\r\n");
}

export function serialize(comp) {
  const lines = [];
  const walk = (c) => {
    lines.push(`BEGIN:${c.name}`);
    for (const p of c.props) lines.push(fold(lineOf(p)));
    for (const ch of c.children) walk(ch);
    lines.push(`END:${c.name}`);
  };
  walk(comp);
  return lines.join("\r\n") + "\r\n";
}

/* ============================================================ Время */

const pad = (n, w = 2) => String(n).padStart(w, "0");

const dtfCache = new Map();
function tzParts(tz, ms) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    });
    dtfCache.set(tz, f);
  }
  const o = {};
  for (const { type, value } of f.formatToParts(new Date(ms))) o[type] = +value;
  return o;
}

function knownTz(tz) {
  try { tzParts(tz, 0); return true; } catch (e) { return false; }
}

// «Настенное» время храним как миллисекунды в фиктивном UTC: так удобно
// прибавлять дни и узнавать день недели без учёта часовых поясов.
export function wallToUtc(wall, tz) {
  if (tz === "UTC") return wall;
  if (!knownTz(tz)) tz = DEFAULT_TZ;
  let utc = wall;
  for (let i = 0; i < 3; i++) {
    const p = tzParts(tz, utc);
    const asWall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const diff = asWall - wall;
    if (!diff) break;
    utc -= diff;
  }
  return utc;
}

export function utcToWall(utc, tz) {
  if (tz === "UTC") return utc;
  if (!knownTz(tz)) tz = DEFAULT_TZ;
  const p = tzParts(tz, utc);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

// Значение даты-времени: { utc, wall, tz, allDay }
export function parseDateValue(value, tzid) {
  const m = /^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d)(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  if (!m[4]) return { wall, utc: wallToUtc(wall, DEFAULT_TZ), tz: DEFAULT_TZ, allDay: true };
  const tz = m[7] ? "UTC" : tzid || DEFAULT_TZ;
  return { wall, utc: wallToUtc(wall, tz), tz, allDay: false };
}

export function dateProp(comp, name) {
  const p = prop(comp, name);
  return p ? parseDateValue(p.value, param(p, "TZID")) : null;
}

function dateList(comp, name) {
  const out = [];
  for (const p of props(comp, name)) {
    for (const v of p.value.split(",")) {
      const d = parseDateValue(v, param(p, "TZID"));
      if (d) out.push(d);
    }
  }
  return out;
}

export function formatDate(d, style) {
  const w = new Date(d.wall);
  const date = `${w.getUTCFullYear()}${pad(w.getUTCMonth() + 1)}${pad(w.getUTCDate())}`;
  if (style.allDay) return date;
  const time = `T${pad(w.getUTCHours())}${pad(w.getUTCMinutes())}${pad(w.getUTCSeconds())}`;
  return date + time + (style.tz === "UTC" ? "Z" : "");
}

function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v || "");
  if (!m) return 0;
  const ms = ((+m[2] || 0) * 7 * DAY) + ((+m[3] || 0) * DAY) + ((+m[4] || 0) * 3600000) + ((+m[5] || 0) * 60000) + ((+m[6] || 0) * 1000);
  return m[1] === "-" ? -ms : ms;
}

function durationOf(ev, start) {
  const end = dateProp(ev, "DTEND");
  if (end) return end.utc - start.utc;
  const dur = prop(ev, "DURATION");
  if (dur) return parseDuration(dur.value);
  return start.allDay ? DAY : 0;
}

/* ============================================================ Повторы */

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function parseRule(value) {
  const r = {};
  for (const part of value.split(";")) {
    const [k, v] = part.split("=");
    if (k) r[k.toUpperCase()] = v;
  }
  return r;
}

// Настенные времена начала повторов, начиная с DTSTART, не позже limitWall
function* occurrences(rule, start, limitUtc) {
  const freq = rule.FREQ;
  const interval = Math.max(1, +rule.INTERVAL || 1);
  const count = rule.COUNT ? +rule.COUNT : Infinity;
  const until = rule.UNTIL ? parseDateValue(rule.UNTIL, start.tz) : null;
  const stopUtc = Math.min(limitUtc, until ? (until.allDay ? until.utc + DAY - 1 : until.utc) : Infinity);
  const timeOfDay = start.wall % DAY;
  const startDay = start.wall - timeOfDay;
  let emitted = 0;

  const emit = function* (wall) {
    if (wall < start.wall) return false;
    const utc = start.tz === "UTC" ? wall : wallToUtc(wall, start.tz);
    if (utc > stopUtc || emitted >= count) return true;
    emitted++;
    yield wall;
    return false;
  };

  for (let i = 0; i < 5000; i++) {
    let stop = false;
    if (freq === "DAILY") {
      stop = yield* emit(startDay + i * interval * DAY + timeOfDay);
    } else if (freq === "WEEKLY") {
      const wkst = WEEKDAYS.indexOf(rule.WKST || "MO");
      const dow = new Date(startDay).getUTCDay();
      const weekStart = startDay - ((dow - wkst + 7) % 7) * DAY + i * interval * 7 * DAY;
      const days = rule.BYDAY
        ? rule.BYDAY.split(",").map((d) => WEEKDAYS.indexOf(d.replace(/^[+-]?\d+/, ""))).filter((d) => d >= 0)
        : [dow];
      const offsets = days.map((d) => (d - wkst + 7) % 7).sort((a, b) => a - b);
      for (const off of offsets) {
        stop = yield* emit(weekStart + off * DAY + timeOfDay);
        if (stop) break;
      }
    } else if (freq === "MONTHLY" || freq === "YEARLY") {
      const d = new Date(startDay);
      const months = freq === "MONTHLY" ? i * interval : i * interval * 12;
      const y = d.getUTCFullYear(), m = d.getUTCMonth() + months, day = d.getUTCDate();
      const cand = Date.UTC(y, m, day);
      // 31-е число в коротком месяце пропускаем, как требует RFC
      if (new Date(cand).getUTCDate() === day) stop = yield* emit(cand + timeOfDay);
    } else {
      yield start.wall;
      return;
    }
    if (stop) return;
  }
}

/**
 * Все события календаря, пересекающие [fromUtc, toUtc).
 * Возвращает { master, event, start, end, recurrenceId, recurring }, где event
 * это компонент с актуальными данными (замена, если она есть), а recurrenceId
 * это исходное начало повтора (UTC, мс) или null для разовых событий.
 */
export function expand(cal, fromUtc, toUtc) {
  const byUid = new Map();
  for (const ev of cal.children.filter((c) => c.name === "VEVENT")) {
    const uid = prop(ev, "UID")?.value || Math.random().toString(36);
    if (!byUid.has(uid)) byUid.set(uid, { master: null, overrides: new Map() });
    const g = byUid.get(uid);
    const rid = dateProp(ev, "RECURRENCE-ID");
    if (rid) g.overrides.set(rid.utc, ev);
    else g.master = ev;
  }

  const out = [];
  const push = (master, ev, recurrenceId, recurring) => {
    const start = dateProp(ev, "DTSTART");
    if (!start) return;
    const end = start.utc + durationOf(ev, start);
    if (prop(ev, "STATUS")?.value?.toUpperCase() === "CANCELLED") return;
    if (end <= fromUtc || start.utc >= toUtc) return;
    out.push({ master, event: ev, uid: prop(ev, "UID")?.value, start, end, recurrenceId, recurring });
  };

  for (const { master, overrides } of byUid.values()) {
    const rrule = master && prop(master, "RRULE");
    if (!master || !rrule) {
      if (master) push(master, master, null, false);
      for (const [rid, ev] of overrides) push(master || ev, ev, rid, true);
      continue;
    }
    const start = dateProp(master, "DTSTART");
    const dur = durationOf(master, start);
    const excluded = new Set(dateList(master, "EXDATE").map((d) => d.utc));
    const walls = [...occurrences(parseRule(rrule.value), start, toUtc)];
    for (const d of dateList(master, "RDATE")) walls.push(d.wall);
    const seen = new Set();
    for (const wall of walls) {
      const utc = start.allDay ? wallToUtc(wall, DEFAULT_TZ) : wallToUtc(wall, start.tz);
      if (seen.has(utc) || excluded.has(utc)) continue;
      seen.add(utc);
      if (overrides.has(utc)) continue;
      if (utc + dur <= fromUtc) continue;
      if (utc >= toUtc) continue;
      out.push({
        master, event: master, uid: prop(master, "UID")?.value,
        start: { ...start, wall, utc }, end: utc + dur, recurrenceId: utc, recurring: true,
      });
    }
    for (const [rid, ev] of overrides) push(master, ev, rid, true);
  }
  return out.sort((a, b) => a.start.utc - b.start.utc);
}

/* ============================================================ Участники */

export const PARTSTATS = ["ACCEPTED", "DECLINED", "TENTATIVE", "NEEDS-ACTION"];

const mailOf = (p) => p.value.replace(/^mailto:/i, "").trim().toLowerCase();

export function findAttendee(ev, emails) {
  const set = new Set(emails.map((e) => e.toLowerCase()));
  return props(ev, "ATTENDEE").find((p) => set.has(mailOf(p)));
}

export function partstatOf(ev, emails) {
  const a = findAttendee(ev, emails);
  return a ? (param(a, "PARTSTAT") || "NEEDS-ACTION").toUpperCase() : null;
}

function cloneComp(c) {
  return {
    name: c.name,
    props: c.props.map((p) => ({ ...p, params: p.params.map(([k, v]) => [k, v]) })),
    children: c.children.map(cloneComp),
  };
}

function dateLine(name, d, style, tzid) {
  const params = style.allDay ? [["VALUE", "DATE"]] : tzid && style.tz !== "UTC" ? [["TZID", tzid]] : [];
  return { name, params, value: formatDate(d, style), raw: null };
}

/**
 * Меняет статус участника. scope: "one" - только повтор recurrenceId,
 * "series" - вся серия и будущие замены. Возвращает число изменённых событий.
 */
export function setPartstat(cal, { uid, recurrenceId, scope, emails, partstat, nowUtc = Date.now() }) {
  const events = cal.children.filter((c) => c.name === "VEVENT" && prop(c, "UID")?.value === uid);
  const master = events.find((e) => !prop(e, "RECURRENCE-ID"));
  const overrides = events.filter((e) => prop(e, "RECURRENCE-ID"));
  const recurring = !!(master && prop(master, "RRULE"));

  const apply = (ev) => {
    const a = findAttendee(ev, emails);
    if (!a) return 0;
    setParam(a, "PARTSTAT", partstat);
    // ответ дан, повторно просить не нужно
    const rsvp = a.params.findIndex(([k]) => k === "RSVP");
    if (rsvp >= 0) a.params.splice(rsvp, 1);
    const stamp = prop(ev, "DTSTAMP");
    if (stamp) { stamp.value = formatDate({ wall: Date.now() - (Date.now() % 1000) }, { tz: "UTC" }); stamp.params = []; stamp.raw = null; }
    return 1;
  };

  let changed = 0;
  if (scope === "series" || recurrenceId == null || !recurring) {
    if (!master && recurrenceId != null) {
      const ov = overrides.find((e) => dateProp(e, "RECURRENCE-ID").utc === recurrenceId);
      return ov ? apply(ov) : 0;
    }
    if (master) changed += apply(master);
    if (scope === "series") {
      for (const ov of overrides) if (dateProp(ov, "DTSTART").utc >= nowUtc) changed += apply(ov);
    }
    return changed;
  }

  const existing = overrides.find((e) => dateProp(e, "RECURRENCE-ID").utc === recurrenceId);
  if (existing) return apply(existing);

  // Замены ещё нет: копируем серию на одну дату, как это делают календари
  if (!findAttendee(master, emails)) return 0;
  const start = dateProp(master, "DTSTART");
  const dur = durationOf(master, start);
  const tzid = param(prop(master, "DTSTART"), "TZID");
  const inst = { wall: start.tz === "UTC" ? recurrenceId : utcToWall(recurrenceId, start.tz) };
  const instEnd = { wall: inst.wall + dur };
  const ov = cloneComp(master);
  ov.props = ov.props.filter((p) => !["RRULE", "RDATE", "EXDATE", "EXRULE", "DTSTART", "DTEND", "DURATION", "RECURRENCE-ID"].includes(p.name));
  const at = Math.max(0, ov.props.findIndex((p) => p.name === "UID") + 1);
  ov.props.splice(at, 0,
    dateLine("RECURRENCE-ID", inst, start, tzid),
    dateLine("DTSTART", inst, start, tzid),
    dateLine("DTEND", instEnd, start, tzid));
  apply(ov);
  cal.children.splice(cal.children.indexOf(master) + 1, 0, ov);
  return 1;
}
