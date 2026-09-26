/* Общий поиск: аудитории, места на плане, преподаватели, предметы и потоки.
   Без запроса - быстрые действия (туалет, поесть, свободные аудитории) и недавнее.
   Преподаватель, предмет или поток открываются списком ближайших пар. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { byDate, CAMPUSES, eventsOn, evKind, roomCampus, roomFloor, roomStatus, type Ev } from "../lib/schedule";
import { getState, setState, useApp } from "../lib/store";
import { closeSearch, openRoute, openSearch, pickRoom, selectPlace, setView, showEvent } from "../lib/actions";
import { addDays, cx, isPhone, lsGet, lsSet, norm, nowMin, parseIso, todayIso } from "../lib/util";
import { allPlaces, getPlace, normQuery, placeWhere, type Place } from "../nav/places";
import { infoText } from "../nav/info";
import { PlaceIcon } from "./Place";
import { statusText } from "./Room";
import { Icon, type IconName } from "./icons";

const FLAG = import.meta.env.BASE_URL + "img/free-rooms-flag.png";
const AHEAD = 21; // пары преподавателя или предмета - на три недели вперёд

/* ---------- индекс: кто и что есть в расписании */
type Who = "t" | "s" | "st"; // преподаватель, предмет, поток
const WHO: Record<Who, { name: string; icon: IconName }> = {
  t: { name: "Преподаватель", icon: "user" },
  s: { name: "Предмет", icon: "book" },
  st: { name: "Поток", icon: "people" },
};
// «🔴 Математический анализ» -> «Математический анализ»
const cleanTitle = (t: string) => t.replace(/^[^\p{L}\p{N}]+/u, "").trim();
const teachersOf = (e: Ev) => e.teachers.split(/,\s*/).filter((t) => t && !t.includes("@"));

let index: Record<Who, string[]> | null = null;
function getIndex() {
  if (index) return index;
  const t = new Set<string>(), s = new Set<string>(), st = new Set<string>();
  for (const list of byDate.values()) {
    for (const e of list) {
      teachersOf(e).forEach((x) => t.add(x));
      s.add(cleanTitle(e.title));
      if (e.stream) st.add(e.stream);
    }
  }
  const sorted = (x: Set<string>) => [...x].filter(Boolean).sort((a, b) => a.localeCompare(b, "ru"));
  return (index = { t: sorted(t), s: sorted(s), st: sorted(st) });
}

const matchOf: Record<Who, (e: Ev, v: string) => boolean> = {
  t: (e, v) => teachersOf(e).includes(v),
  s: (e, v) => cleanTitle(e.title) === v,
  st: (e, v) => e.stream === v,
};

// Пары с сегодняшнего дня: сегодняшние прошедшие тоже, чтобы было видно, где был
function upcoming(who: Who, v: string, limit = 60) {
  const out: Ev[] = [];
  const today = todayIso();
  for (let i = 0; i < AHEAD && out.length < limit; i++) {
    for (const e of eventsOn(addDays(today, i))) if (matchOf[who](e, v)) out.push(e);
  }
  return out.slice(0, limit);
}

const shortDay = new Intl.DateTimeFormat("ru-RU", { weekday: "short", day: "numeric", month: "long" });
const dayName = (d: string) => {
  const today = todayIso();
  if (d === today) return "сегодня";
  if (d === addDays(today, 1)) return "завтра";
  return shortDay.format(parseIso(d));
};

// «сейчас в B214 до 12:30», «завтра в 10:30, B214»
function nextText(who: Who, v: string) {
  const now = nowMin(), today = todayIso();
  const e = upcoming(who, v, 40).find((e) => e.date > today || e.e > now);
  if (!e) return "в ближайшие три недели пар нет";
  const rooms = e.rooms.join(", ");
  if (e.date === today && e.s <= now) return `сейчас: ${rooms}, до ${e.end}`;
  return `${dayName(e.date)} в ${e.start}, ${rooms}`;
}

/* ---------- совпадение с запросом: 0 - начало, 1 - начало слова, 2 - все слова запроса, 3 - где-то внутри */
function score(text: string, q: string) {
  const t = norm(text);
  if (!t || !q) return -1;
  if (t.startsWith(q)) return 0;
  const words = t.split(/[\s«»().,:/-]+/);
  if (words.some((w) => w.startsWith(q))) return 1;
  const qw = q.split(" ");
  if (qw.length > 1 && qw.every((x) => words.some((w) => w.startsWith(x)))) return 2;
  return t.includes(q) ? 3 : -1;
}

/* ---------- недавнее: что открывали из поиска */
const RECENT_KEY = "cu.recent";
function readRecent(): string[] {
  try { const v = JSON.parse(lsGet(RECENT_KEY) || "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; }
}
function remember(id: string) {
  lsSet(RECENT_KEY, JSON.stringify([id, ...readRecent().filter((x) => x !== id)].slice(0, 6)));
}

/* ---------- быстрые действия */
function openFree() {
  // свободные аудитории - экран общего списка пар, в режиме «мои пары» его нет
  setState({ freeScreen: true, mine: false, room: null, place: null, roomScreen: false });
  if (isPhone()) setView("list");
}
// ближайшее - от выбранной аудитории или места, иначе от входа
const fromHere = () => { const s = getState(); return s.room ? "r:" + s.room : s.place; };
interface Quick { id: string; title: string; sub: string; icon: IconName | "flag"; tone: string; words: string; run?: () => void; query?: string }
const QUICK: Quick[] = [
  { id: "wc", title: "Туалет", sub: "ближайший, с маршрутом", icon: "wc", tone: "gray", words: "туалет wc уборная", run: () => openRoute({ from: fromHere(), to: "n:wc" }) },
  { id: "food", title: "Поесть", sub: "ближайшая кухня или кафе", icon: "cup", tone: "kitchen", words: "поесть еда кухня кафе обед кофе столовая перекус", run: () => openRoute({ from: fromHere(), to: "n:food" }) },
  { id: "free", title: "Свободные аудитории", sub: "где сесть позаниматься", icon: "flag", tone: "free", words: "свободные аудитории пустые свободно позаниматься", run: openFree },
  { id: "cowork", title: "Коворкинг", sub: "открытые места для учёбы", icon: "desk", tone: "open", words: "коворкинг опенспейс позаниматься", query: "Коворкинг" },
  { id: "cloak", title: "Гардероб", sub: "куда сдать куртку", icon: "door", tone: "gray", words: "гардероб куртка одежда", query: "Гардероб" },
  { id: "route", title: "Маршрут", sub: "откуда и куда угодно", icon: "route", tone: "accent", words: "маршрут как пройти дорога добраться", run: () => openRoute() },
];

function QuickIcon({ q }: { q: Quick }) {
  return <span className={cx("pl-ic", "tone-" + q.tone)}>{q.icon === "flag" ? <img src={FLAG} alt="" /> : <Icon name={q.icon} />}</span>;
}

/* ---------- результаты */
interface Item { id: string; icon: ReactNode; title: ReactNode; sub: ReactNode; aside?: ReactNode; run: () => void; recent?: string }
interface Group { id: string; title: string; items: Item[]; more: number }

function roomItem(p: Place, date: string, t: number): Item {
  const st = roomStatus(p.room!, date, t);
  return {
    id: p.key, recent: "p:" + p.key,
    icon: <span className="sr-code">{p.room!.replace(/\d.*/, "") || "·"}</span>,
    title: <>Аудитория {p.room}</>,
    sub: `${roomFloor[p.room!]} этаж · ${CAMPUSES[roomCampus[p.room!]].short}`,
    aside: <span className={cx("sr-st", st.st)}>{statusText(st).replace("Свободна до конца дня", "Свободна")}</span>,
    run: () => pickRoom(p.room!),
  };
}
const placeItem = (p: Place): Item => ({
  id: p.key, recent: "p:" + p.key, icon: <PlaceIcon p={p} />, title: p.title, sub: placeWhere(p),
  run: () => selectPlace(p.key, true),
});
const whoItem = (who: Who, v: string, open: (who: Who, v: string) => void): Item => ({
  id: who + ":" + v, recent: who + ":" + v,
  icon: <span className={cx("pl-ic", "tone-who")}><Icon name={WHO[who].icon} /></span>,
  title: v, sub: nextText(who, v), aside: <Icon name="next" className="sr-go" />,
  run: () => open(who, v),
});

function search(query: string, open: (who: Who, v: string) => void, expanded: Set<string>, date: string, t: number): Group[] {
  const q = normQuery(query);
  if (!q) return [];
  const { campus, floor } = getState();
  const groups: Group[] = [];
  const add = (id: string, title: string, all: Item[], limit: number) => {
    if (!all.length) return;
    const n = expanded.has(id) ? all.length : limit;
    groups.push({ id, title, items: all.slice(0, n), more: all.length - n });
  };

  const quick = QUICK.filter((x) => x.run && x.words.split(" ").some((w) => w.startsWith(q) || (q.length > 3 && q.startsWith(w))));
  add("quick", "Быстро", quick.map((x) => ({ id: "q:" + x.id, icon: <QuickIcon q={x} />, title: x.title, sub: x.sub, run: x.run! })), 3);

  const rooms: { p: Place; s: number }[] = [], places: { p: Place; s: number }[] = [];
  const seen = new Set<string>();
  for (const p of allPlaces()) {
    if (p.kind === "point" || p.kind === "nearest") continue;
    let s = Math.min(...[p.title, p.sub, p.label || ""].map((x) => score(x, q)).map((x) => (x < 0 ? 99 : x)));
    if (s === 99 && p.kind !== "room") s = score(infoText(p), q) >= 0 ? 4 : 99;
    if (s === 99) continue;
    // одинаковые подписи без кода на этаже («Кухня», «Мужской туалет») - один раз
    const k = p.title + p.sub + p.floor + p.campus;
    if (seen.has(k)) continue;
    seen.add(k);
    s += p.campus === campus ? 0 : 5;
    (p.kind === "room" ? rooms : places).push({ p, s });
  }
  // при равном совпадении ближе к этажу, который открыт на плане
  const off = (p: Place) => Math.abs(p.floor! - floor);
  const bySc = (a: { p: Place; s: number }, b: { p: Place; s: number }) =>
    a.s - b.s || off(a.p) - off(b.p) || a.p.floor! - b.p.floor! || a.p.title.localeCompare(b.p.title, "ru", { numeric: true });
  add("rooms", "Аудитории", rooms.sort(bySc).map(({ p }) => roomItem(p, date, t)), 5);
  add("places", "Места", places.sort(bySc).map(({ p }) => placeItem(p)), 5);

  const idx = getIndex();
  for (const [who, title, limit] of [["t", "Преподаватели", 5], ["s", "Предметы", 5], ["st", "Потоки", 3]] as [Who, string, number][]) {
    const found = idx[who].map((v) => ({ v, s: score(v, q) })).filter((x) => x.s >= 0).sort((a, b) => a.s - b.s);
    add(who, title, found.map(({ v }) => whoItem(who, v, open)), limit);
  }
  return groups;
}

function recentItems(open: (who: Who, v: string) => void, date: string, t: number): Item[] {
  return readRecent().flatMap((id): Item[] => {
    const m = /^(p|t|s|st):(.+)$/.exec(id);
    if (!m) return [];
    if (m[1] === "p") {
      const p = getPlace(m[2]);
      if (!p || p.kind === "point") return [];
      return [p.kind === "room" ? roomItem(p, date, t) : placeItem(p)];
    }
    return getIndex()[m[1] as Who].includes(m[2]) ? [whoItem(m[1] as Who, m[2], open)] : [];
  });
}

/* ---------- пары преподавателя, предмета или потока */
function Detail({ who, v, onBack }: { who: Who; v: string; onBack: () => void }) {
  const evs = useMemo(() => upcoming(who, v), [who, v]);
  const now = nowMin(), today = todayIso();
  const days = new Map<string, Ev[]>();
  for (const e of evs) (days.get(e.date) || days.set(e.date, []).get(e.date)!).push(e);
  const go = (e: Ev, room?: string) => { closeSearch(); showEvent(e, room); };
  return (
    <div className="sr-detail">
      <div className="sr-dhead">
        <button className="sr-back" onClick={onBack} title="К результатам"><Icon name="back" /></button>
        <span className={cx("pl-ic", "tone-who")}><Icon name={WHO[who].icon} /></span>
        <span className="sr-dt"><small>{WHO[who].name}</small><b>{v}</b></span>
      </div>
      {!evs.length && <p className="sr-empty">В ближайшие три недели пар в аудиториях кампуса нет</p>}
      {[...days].map(([d, list]) => (
        <div key={d} className="sr-day">
          <h4>{dayName(d)}</h4>
          {list.map((e, i) => {
            const past = d === today && e.e <= now, cur = d === today && e.s <= now && now < e.e;
            const meta = who === "t" ? e.stream : who === "st" ? e.teachers : [e.teachers, e.stream].filter(Boolean).join(" · ");
            return (
              <div key={i} className={cx("sr-ev", past && "past", cur && "now")} role="button" tabIndex={0}
                onClick={() => go(e)} onKeyDown={(k) => { if (k.key === "Enter") go(e); }}>
                <span className="sr-time">{e.start}<small>{e.end}</small></span>
                <span className="sr-evb">
                  <b>{who === "s" ? e.type : e.title}</b>
                  <span className="sr-evm">
                    {e.rooms.map((r) => (
                      <button key={r} className="room" onClick={(x) => { x.stopPropagation(); go(e, r); }} title="Показать на плане">{r}</button>
                    ))}
                    {who !== "s" && <span className={cx("kind", evKind(e.type))}>{e.type}</span>}
                    {meta && <span className="sr-evx">{meta}</span>}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function SearchLayer() {
  const open = useApp((s) => s.search);
  if (!open) return null;
  return <SearchPanel />;
}

function SearchPanel() {
  const date = useApp((s) => s.date), t = useApp((s) => s.t);
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<{ who: Who; v: string } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [active, setActive] = useState(0);
  const [recentVer, setRecentVer] = useState(0);
  const input = useRef<HTMLInputElement>(null), body = useRef<HTMLDivElement>(null);

  const openWho = (who: Who, v: string) => { remember(who + ":" + v); setDetail({ who, v }); };
  const groups = useMemo(() => search(query, openWho, expanded, date, t), [query, expanded, date, t]);
  const recent = useMemo(() => (query ? [] : recentItems(openWho, date, t)), [query, date, t, recentVer]);
  const flat = query ? groups.flatMap((g) => g.items) : recent;

  useEffect(() => { input.current?.focus(); }, [detail]);
  useEffect(() => { setActive(0); }, [query]);
  useLayoutEffect(() => { body.current?.querySelector(".sr-item.on")?.scrollIntoView({ block: "nearest" }); }, [active]);
  useEffect(() => { if (body.current) body.current.scrollTop = 0; }, [detail]);

  const run = (it: Item) => {
    if (it.recent) remember(it.recent);
    // преподаватель, предмет, поток открываются внутри поиска
    if (/^(t|s|st):/.test(it.id)) return it.run();
    closeSearch();
    it.run();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); if (detail) setDetail(null); else if (query) setQuery(""); else closeSearch(); return; }
    if (detail) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(flat.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter" && flat[active]) { e.preventDefault(); run(flat[active]); }
  };

  let n = 0;
  const row = (it: Item) => {
    const i = n++;
    return (
      <li key={it.id}>
        <button className={cx("sr-item", i === active && "on")} onClick={() => run(it)} onPointerMove={() => i !== active && setActive(i)}>
          {it.icon}
          <span className="sr-t"><b>{it.title}</b><small>{it.sub}</small></span>
          {it.aside}
        </button>
      </li>
    );
  };

  let content;
  if (detail) content = <Detail who={detail.who} v={detail.v} onBack={() => setDetail(null)} />;
  else if (!query.trim()) {
    content = (
      <>
        <div className="sr-quick">
          {QUICK.map((x) => (
            <button key={x.id} onClick={() => { if (x.query) setQuery(x.query); else { closeSearch(); x.run!(); } }}>
              <QuickIcon q={x} />
              <b>{x.title}</b>
              <small>{x.sub}</small>
            </button>
          ))}
        </div>
        {!!recent.length && (
          <section className="sr-group">
            <h3>Недавнее<button className="sr-more" onClick={() => { lsSet(RECENT_KEY, null); setRecentVer((v) => v + 1); }}>Очистить</button></h3>
            <ul>{recent.map(row)}</ul>
          </section>
        )}
        <p className="sr-tip">Ищите аудиторию («318», «т318»), место («кухня», «переговорная»), преподавателя, предмет или поток.</p>
      </>
    );
  } else if (!groups.length) {
    content = <p className="sr-empty">Ничего не нашлось. Попробуйте номер аудитории, фамилию или часть названия предмета.</p>;
  } else {
    content = groups.map((g) => (
      <section key={g.id} className="sr-group">
        <h3>{g.title}</h3>
        <ul>{g.items.map(row)}</ul>
        {g.more > 0 && <button className="sr-more" onClick={() => setExpanded((e) => new Set(e).add(g.id))}>Показать ещё {g.more}</button>}
      </section>
    ));
  }

  return (
    <div className="search-layer" onPointerDown={(e) => { if (e.target === e.currentTarget) closeSearch(); }}>
      <div className="search-panel" role="dialog" aria-modal="true" aria-label="Поиск" onKeyDown={onKey}>
        <div className="sr-bar">
          <label className="sr-field">
            <Icon name="search" />
            <input ref={input} type="search" enterKeyHint="search" autoComplete="off" spellCheck={false}
              placeholder="Аудитория, место, преподаватель, предмет" value={query}
              onChange={(e) => { setQuery(e.target.value); setDetail(null); setExpanded(new Set()); }} />
            {query && (
              <button className="sr-clear" title="Очистить" onPointerDown={(e) => e.preventDefault()}
                onClick={() => { setQuery(""); setDetail(null); input.current?.focus(); }}><Icon name="close" /></button>
            )}
          </label>
          <button className="sr-cancel" onClick={closeSearch}>Отмена</button>
        </div>
        <div className="sr-body" ref={body}>{content}</div>
      </div>
    </div>
  );
}

// Кнопка поиска: на компьютере поле в шапке плана, на телефоне круглая кнопка поверх плана
export function SearchButton() {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <button className="search-btn" onClick={openSearch} title="Поиск" aria-label="Поиск">
      <Icon name="search" />
      <span className="sb-t">Поиск</span>
      <kbd>{mac ? "⌘K" : "Ctrl K"}</kbd>
    </button>
  );
}
