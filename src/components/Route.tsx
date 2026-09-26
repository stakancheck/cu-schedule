/* Маршруты: панель выбора, карточка шага поверх плана, выбор точки на плане */
import { useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { useApp, type Field } from "../lib/store";
import {
  closeRoute, finishRoute, goStep, routeBack, selectOption, setRoutePlace, startPick, swapRoute,
} from "../lib/actions";
import { useAccountVersion } from "../lib/account";
import { myRooms } from "../lib/mine";
import { findPlaces, getPlace, placeName, placeWhere, type Place } from "../nav/places";
import { fmtDur, fmtLen, optTitle, type Option, type Step } from "../nav/steps";
import { cx, isPhone } from "../lib/util";
import { Icon } from "./icons";

function sgIcon(p: Place) {
  if (p.kind === "room") return p.title.replace(/\d.*/, "") || "·";
  if (p.kind === "entrance") return "→";
  if (p.kind === "nearest") return p.key === "n:wc" ? "WC" : "☕";
  if (p.kind === "wc") return "WC";
  return "•";
}

// Шаг по городу: как ехать по пунктам и ссылка на живой маршрут в Картах
function CityText({ s, link = true }: { s: Step; link?: boolean }) {
  if (s.leg.type !== "city") return null;
  return (
    <span className="rt-st">
      <b>{s.text}</b>
      <ol className="city-lines">{s.leg.lines.map((l, i) => <li key={i}>{l}</li>)}</ol>
      <small>{s.meta}</small>
      {link && <MapsLink s={s} />}
    </span>
  );
}
const MapsLink = ({ s }: { s: Step }) => s.leg.type === "city"
  ? <a className="city-maps" href={s.leg.url} target="_blank" rel="noopener">Маршрут в Яндекс Картах ↗</a> : null;

function Chips({ o }: { o: Option }) {
  return (
    <span className="rt-chips">
      {o.steps.map((s, i) => (
        <span key={i} className="rt-chip-wrap">
          {i > 0 && <span className="rc-sep">›</span>}
          {s.leg.type === "city"
            ? <span className="rc city" title={s.meta}><Icon name={s.kind} />{fmtDur(s.leg.time).replace("≈ ", "")}</span>
            : s.kind === "walk"
              ? <span className="rc"><Icon name="walk" />{s.floor} этаж</span>
              : <span className={cx("rc", s.kind)} title={s.meta}><Icon name={s.kind} /></span>}
        </span>
      ))}
    </span>
  );
}

type Edit = { field: Field; query: string } | null;

// Поле «откуда» или «куда»: пока его редактируют, под формой видны подсказки
function PlaceField({ field, edit, setEdit }: { field: Field; edit: Edit; setEdit: (fn: (e: Edit) => Edit) => void }) {
  const r = useApp((s) => s.route);
  const input = useRef<HTMLInputElement>(null);
  const place = getPlace(r[field]);
  const mine = edit?.field === field;
  const value = mine ? edit.query : place ? placeName(place) : "";
  return (
    <label className={cx("rt-field", mine && "on", (value || place) && "filled")}>
      <span className="sr">{field === "from" ? "Откуда" : "Куда"}</span>
      <input ref={input} id={field === "from" ? "rtFrom" : "rtTo"} type="text" autoComplete="off" enterKeyHint="done"
        placeholder={field === "from" ? "Откуда" : "Куда: аудитория, кухня, вход"} value={value}
        onFocus={() => setEdit(() => ({ field, query: "" }))}
        onChange={(e) => setEdit(() => ({ field, query: e.target.value }))}
        // другое поле могло уже получить фокус: снимаем только своё
        onBlur={() => setTimeout(() => setEdit((e) => (e?.field === field ? null : e)), 120)}
        onKeyDown={(e) => {
          if (e.key === "Escape") input.current?.blur();
          if (e.key === "Enter") {
            document.querySelector("#rtSugg [data-place]")?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
          }
        }} />
      {(value || place) && (
        <button className="rt-clear" type="button" title="Очистить" aria-label="Очистить"
          onPointerDown={(e) => e.preventDefault() /* не забираем фокус у поля */}
          onClick={(e) => {
            e.preventDefault();
            setRoutePlace(field, null);
            setEdit(() => ({ field, query: "" }));
            if (document.activeElement !== input.current) input.current?.focus();
          }}>
          <Icon name="close" />
        </button>
      )}
    </label>
  );
}

function Suggestions({ field, query, onChosen }: { field: Field; query: string; onChosen: () => void }) {
  useAccountVersion();
  const r = useApp((s) => s.route), date = useApp((s) => s.date), campus = useApp((s) => s.campus);
  const other = field === "to" ? r.from : r.to;
  const cid = (field === "to" && getPlace(r.from)?.campus) || campus;
  const list = findPlaces(query, field, cid, other, [...myRooms(date).keys()]);
  // pointerdown, а не click: иначе поле теряет фокус раньше и список пропадает
  const choose = (e: RPointerEvent | PointerEvent, fn: () => void) => {
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur?.();
    onChosen();
    fn();
  };
  return (
    <ul className="rt-sugg" id="rtSugg">
      <li><button data-pickmap="1" onPointerDown={(e) => choose(e, () => startPick(field))}>
        <span className="rt-sg-ic map"><Icon name="pin" /></span>
        <span className="rt-sg-t"><b>Указать на карте</b><small>нажмите на нужное место на плане</small></span>
      </button></li>
      {list.map(({ p, hint }) => (
        <li key={p.key}><button data-place={p.key} onPointerDown={(e) => choose(e, () => setRoutePlace(field, p.key))}>
          <span className={cx("rt-sg-ic", p.kind)}>{sgIcon(p)}</span>
          <span className="rt-sg-t"><b>{placeName(p)}</b><small>{hint || placeWhere(p)}</small></span>
        </button></li>
      ))}
      {!list.length && <li className="rt-none">Ничего не нашлось</li>}
    </ul>
  );
}

export function RoutePanel() {
  const r = useApp((s) => s.route);
  const [edit, setEditState] = useState<Edit>(null);
  const setEdit = (fn: (e: Edit) => Edit) => setEditState(fn);
  let body;
  if (!r.from || !r.to) {
    body = <p className="rt-hint">Выберите, откуда и куда идти: начните вводить номер аудитории или название{isPhone() ? "" : ", а можно просто нажать на аудиторию на плане"}.</p>;
  } else if (r.busy) body = <p className="rt-hint">Строю маршрут…</p>;
  else if (r.error || !r.options) body = <div className="form-error">{r.error || "Не получилось проложить маршрут"}</div>;
  else {
    body = (
      <div className="rt-opts">
        {r.options.map((o, i) => {
          const on = i === r.sel;
          return (
            <div key={i} className={cx("rt-opt", on && "on")}>
              <button className="rt-opt-main" onClick={() => selectOption(i)}>
                <span className="rt-opt-top"><b>{optTitle(o, i)}</b><span>{fmtDur(o.time)} · {fmtLen(o.walk)}</span></span>
                <Chips o={o} />
              </button>
              {on && (
                <ol className="rt-steps">
                  {o.steps.map((s, k) => (
                    <li key={k}><button className={cx(k === r.step && "on")} onClick={() => goStep(k)}>
                      <span className={cx("rs-ic", s.kind)}><Icon name={s.kind} /></span>
                      {s.leg.type === "city" ? <CityText s={s} link={false} /> : <span className="rt-st"><b>{s.text}</b><small>{s.meta}</small></span>}
                    </button>{s.leg.type === "city" && <div className="city-link-row"><MapsLink s={s} /></div>}</li>
                  ))}
                </ol>
              )}
              {on && <button className="primary-btn rt-go" onClick={() => goStep(0)}><Icon name="route" />Идти по шагам</button>}
            </div>
          );
        })}
      </div>
    );
  }
  return (
    <section className="route-panel">
      <div className="rt-head">
        <button className="rt-close" onClick={closeRoute}><Icon name="back" />Назад</button>
        <h2>Маршрут</h2>
      </div>
      <div className="rt-form">
        <div className="rt-rail" aria-hidden="true"><i className="rt-a" /><i className="rt-line-v" /><i className="rt-b" /></div>
        <div className="rt-inputs">
          <PlaceField field="from" edit={edit} setEdit={setEdit} />
          <PlaceField field="to" edit={edit} setEdit={setEdit} />
        </div>
        <button className="icon-btn rt-swap" title="Поменять местами" onClick={swapRoute}><Icon name="swap" /></button>
      </div>
      {edit && <Suggestions field={edit.field} query={edit.query} onChosen={() => setEdit(() => null)} />}
      <div className="rt-body">{body}</div>
    </section>
  );
}

// Пошаговый режим: карточка шага поверх плана, листается кнопками и свайпом
export function RouteSheet() {
  const r = useApp((s) => s.route);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const o = r.open && r.options ? r.options[r.sel] : null;
  if (!o || r.step < 0 || r.picking) return null;
  const s = o.steps[r.step], last = r.step === o.steps.length - 1;
  return (
    <div className="route-sheet" id="routeSheet"
      onPointerDown={(e) => { if (e.pointerType !== "mouse") swipe.current = { x: e.clientX, y: e.clientY }; }}
      onPointerCancel={() => { swipe.current = null; }}
      onPointerUp={(e) => {
        const st = swipe.current;
        swipe.current = null;
        if (!st) return;
        const dx = e.clientX - st.x, dy = e.clientY - st.y;
        if (Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx)) return;
        goStep(r.step + (dx < 0 ? 1 : -1));
      }}>
      <div className="rs-top">
        <button className="rs-back" onClick={routeBack} title="К выбору маршрута"><Icon name="back" /></button>
        <b className="rs-title">{s.title}</b>
        <span className="rs-dots">{o.steps.map((_, i) => <i key={i} className={cx(i === r.step ? "on" : i < r.step && "done")} />)}</span>
      </div>
      <div className="rs-step">
        <span className={cx("rs-ic", s.kind)}><Icon name={s.kind} /></span>
        {s.leg.type === "city" ? <CityText s={s} /> : <span className="rt-st"><b>{s.text}</b><small>{s.meta}</small></span>}
      </div>
      <div className="rs-actions">
        <button className="rs-prev" disabled={!r.step} onClick={() => goStep(r.step - 1)}>Назад</button>
        {last
          ? <button className="primary-btn" onClick={finishRoute}>Завершить</button>
          : <button className="primary-btn" onClick={() => goStep(r.step + 1)}>Далее</button>}
      </div>
    </div>
  );
}

export function PickBar() {
  const picking = useApp((s) => s.route.picking);
  if (!picking) return null;
  return (
    <div className="pick-bar">
      <span className="pick-ic"><Icon name="pin" /></span>
      <span className="pick-t"><b>{picking === "from" ? "Нажмите на плане, откуда идти" : "Нажмите на плане, куда идти"}</b><small>аудиторию или любую точку в здании, этаж можно сменить</small></span>
      <button className="pick-x" onClick={routeBack}>Отмена</button>
    </div>
  );
}
