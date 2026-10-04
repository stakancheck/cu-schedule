/* Место без расписания (кухня, переговорная, туалет, лестница): что это и как дойти.
   На телефоне карточка поверх плана, на компьютере - правая колонка. */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useApp } from "../lib/store";
import { openRoute, revealSelection, selectPlace } from "../lib/actions";
import { cx, norm } from "../lib/util";
import { allPlaces, getPlace, placeWhere, type Place } from "../nav/places";
import { CATS, isOpenAt, placeInfo } from "../nav/info";
import { Icon } from "./icons";
import { openReportAt } from "../lib/report";


export function PlaceIcon({ p, className }: { p: Place; className?: string }) {
  const i = placeInfo(p), c = CATS[i.cat], brand = i.note?.brand;
  if (brand) return <span className={cx("pl-ic", "pl-brand", className)} style={{ background: brand.color, color: brand.ink || "#fff" }}><Icon name={brand.icon} /></span>;
  return (
    <span className={cx("pl-ic", "tone-" + c.tone, className)}>
      {i.note?.emoji ? <span className="pl-emoji">{i.note.emoji}</span> : <Icon name={p.kind === "link" && /лифт/i.test(p.title) ? "lift" : c.icon} />}
    </span>
  );
}

const dist = (a: Place, b: Place) => Math.hypot(a.x! - b.x!, a.y! - b.y!);

// Такие же места в кампусе: сначала на этом этаже, потом на ближайших; одинаковые на этаже - один раз
function similar(p: Place, limit: number) {
  const cat = placeInfo(p).cat, t = norm(p.label || p.title);
  if (cat === "other" || cat === "staff") return [];
  const seen = new Set<string>([p.title + p.floor]);
  const out: Place[] = [];
  const cands = [...allPlaces()].filter((q) => q.campus === p.campus && q.key !== p.key && q.kind !== "point" && q.kind !== "room" && placeInfo(q).cat === cat)
    // у туалетов, лестниц и еды «такие же» - вся категория, у остального - с тем же названием
    .filter((q) => ["wc", "move", "food"].includes(cat) || norm(q.label || q.title).split(" ")[0] === t.split(" ")[0])
    .sort((a, b) => Math.abs(a.floor! - p.floor!) - Math.abs(b.floor! - p.floor!) || a.floor! - b.floor! || dist(a, p) - dist(b, p));
  for (const q of cands) {
    const k = q.title + q.floor;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(q);
    if (out.length >= limit) break;
  }
  return out;
}

const plural = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? "нюанс" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "нюанса" : "нюансов");

// Почта в тексте нюанса - ссылка
const Linked = ({ text }: { text: string }) => (
  <>{text.split(/(\S+@\S+\.[a-z]+)/).map((x, k) => (k % 2 ? <a key={k} href={"mailto:" + x}>{x}</a> : x))}</>
);

// limit - сколько нюансов показать сразу (карточка поверх плана не должна закрывать его целиком)
function PlaceAbout({ p, limit = Infinity }: { p: Place; limit?: number }) {
  const i = placeInfo(p), n = i.note;
  const date = useApp((s) => s.date), t = useApp((s) => s.t), live = useApp((s) => s.live);
  const open = n?.weekly ? isOpenAt(n.weekly, date, t) : null;
  const [all, setAll] = useState(false);
  useEffect(() => setAll(false), [p.key]);
  const facts = n?.facts || [], shown = all ? facts : facts.slice(0, limit);
  return (
    <div className="pl-about">
      {open !== null && <div className="pl-open-status">
        <span className={cx("pl-open-pill", open ? "open" : "closed")}>{open ? "Открыто" : "Закрыто"}</span>
        <small>{live ? "сейчас" : "на выбранное время"}</small>
      </div>}
      {i.about && <p>{i.about}</p>}
      {(n?.hours || n?.who) && (
        <p className="pl-meta">
          {n.hours && <span><Icon name="clock" />{n.hours}</span>}
          {n.who && <span><Icon name="user" />{n.who}</span>}
        </p>
      )}
      {!!shown.length && <ul className="pl-facts">{shown.map((f, k) => <li key={k}><Linked text={f} /></li>)}</ul>}
      {shown.length < facts.length && (
        <button className="pl-more" onClick={() => setAll(true)}>Ещё {facts.length - shown.length} {plural(facts.length - shown.length)}</button>
      )}
      {!!n?.links?.length && <div className="pl-links">{n.links.map((link) => (
        <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer">{link.label}</a>
      ))}</div>}
      {!i.own && !n?.facts?.length && p.kind !== "link" && p.kind !== "wc" && (
        <p className="pl-ask">
          {i.about ? "Знаете подробности" : "Знаете, что здесь"}: что есть, когда открыто, кому можно?{" "}
          <button className="pl-ask-btn" onClick={() => openReportAt(p.key)}>Напишите</button>, добавим.
        </p>
      )}
    </div>
  );
}

function Similar({ p, limit }: { p: Place; limit: number }) {
  const list = similar(p, limit);
  if (!list.length) return null;
  const same = list.every((q) => q.title === p.title);
  return (
    <div className="pl-similar">
      <span className="pl-sim-t">{same ? "Ещё" : "Рядом похожее"}</span>
      <div className="pl-sim-list">
        {list.map((q) => (
          <button key={q.key} onClick={() => selectPlace(q.key, true)} title={placeWhere(q)}>
            {!same && <b>{q.title}</b>}{q.floor} этаж
          </button>
        ))}
      </div>
    </div>
  );
}

function RouteBtns({ p, className }: { p: Place; className: string }) {
  return (
    <div className={className}>
      <button className="pk-from" onClick={() => openRoute({ from: p.key })}>Отсюда</button>
      <button className="pk-to on" onClick={() => openRoute({ to: p.key })}><Icon name="route" />Сюда</button>
    </div>
  );
}

// Телефон: карточка выбранного места поверх плана
export function PlacePeek() {
  const p = getPlace(useApp((s) => s.place));
  const card = useRef<HTMLDivElement>(null);
  // выбранное место не должно оказаться под карточкой
  useLayoutEffect(() => { if (p) revealSelection(card.current); }, [p?.key]);
  if (!p) return null;
  return (
    <div className="room-peek place-peek" ref={card}>
      <div className="pk-head">
        <PlaceIcon p={p} />
        <span className="pl-title"><b>{p.title}</b><span className="pk-where">{placeWhere(p)}</span></span>
        <button className="pk-x" onClick={() => selectPlace(null)} title="Сбросить выбор"><Icon name="close" /></button>
      </div>
      <PlaceAbout p={p} limit={2} />
      <Similar p={p} limit={6} />
      <RouteBtns p={p} className="pk-actions pl-actions" />
    </div>
  );
}

// Компьютер: место в правой колонке вместо общего расписания
export function PlaceScreen() {
  const p = getPlace(useApp((s) => s.place));
  if (!p) return null;
  const cat = CATS[placeInfo(p).cat];
  return (
    <section className="place-screen">
      <div className="rt-head">
        <button className="rt-close" onClick={() => selectPlace(null)}><Icon name="back" />Все пары</button>
        <h2>{cat.name}</h2>
      </div>
      <div className="room-card place-card">
        <div className="pl-top">
          <PlaceIcon p={p} />
          <span className="pl-title"><b>{p.title}</b><span className="where">{placeWhere(p)}</span></span>
        </div>
        <PlaceAbout p={p} />
        <RouteBtns p={p} className="rc-route" />
      </div>
      <Similar p={p} limit={10} />
    </section>
  );
}
