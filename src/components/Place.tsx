/* Место без расписания (кухня, переговорная, туалет, лестница): что это и как дойти.
   На телефоне карточка поверх плана, на компьютере - правая колонка. */
import { useApp } from "../lib/store";
import { openRoute, selectPlace } from "../lib/actions";
import { cx, norm } from "../lib/util";
import { allPlaces, getPlace, placeWhere, type Place } from "../nav/places";
import { CATS, placeInfo } from "../nav/info";
import { Icon } from "./icons";

const CONTACT = "https://t.me/stakancheck";

export function PlaceIcon({ p, className }: { p: Place; className?: string }) {
  const c = CATS[placeInfo(p).cat];
  return <span className={cx("pl-ic", "tone-" + c.tone, className)}><Icon name={p.kind === "link" && p.title === "Лифт" ? "lift" : c.icon} /></span>;
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

function PlaceAbout({ p }: { p: Place }) {
  const i = placeInfo(p), n = i.note;
  return (
    <div className="pl-about">
      {i.about && <p>{i.about}</p>}
      {(n?.hours || n?.who) && (
        <p className="pl-meta">
          {n.hours && <span><Icon name="clock" />{n.hours}</span>}
          {n.who && <span><Icon name="user" />{n.who}</span>}
        </p>
      )}
      {!!n?.facts?.length && <ul className="pl-facts">{n.facts.map((f, k) => <li key={k}>{f}</li>)}</ul>}
      {!n && p.kind !== "link" && p.kind !== "wc" && (
        <p className="pl-ask">
          {i.about ? "Знаете подробности" : "Знаете, что здесь"}: что есть, когда открыто, кому можно?{" "}
          <a href={CONTACT} target="_blank" rel="noopener">Напишите</a>, добавим.
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
  if (!p) return null;
  return (
    <div className="room-peek place-peek">
      <div className="pk-head">
        <PlaceIcon p={p} />
        <span className="pl-title"><b>{p.title}</b><span className="pk-where">{placeWhere(p)}</span></span>
        <button className="pk-x" onClick={() => selectPlace(null)} title="Сбросить выбор"><Icon name="close" /></button>
      </div>
      <PlaceAbout p={p} />
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
