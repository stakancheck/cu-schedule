/* Обращения: неточность на плане с отметкой на карте, ошибка в приложении, идея.
   Форма - карточка поверх плана; пока указывают точку, её нет, остаётся подсказка. */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useApp, type Pin } from "../lib/store";
import { planCtl } from "../lib/actions";
import {
  cancelPick, check, clearPin, closeReport, deviceInfo, KIND_LABEL, markIntroSeen, introSeen, openReport, patchReport, sendReport, startPin,
  TEXT_MAX, tgUsername, thanks, wait,
} from "../lib/report";
import { CAMPUSES } from "../lib/schedule";
import { cx, isPhone } from "../lib/util";
import { Icon } from "./icons";

const LEGAL = import.meta.env.BASE_URL + "legal/";
const KINDS = ["map", "bug", "idea"] as const;
const HINT = {
  map: "Что на плане не так и как должно быть: например, «здесь есть дверь» или «аудитория подписана N312, а должна N321».",
  bug: "Что сломалось: что нажимали, что ожидали и что получилось.",
  idea: "Что добавить или улучшить.",
};

const useReport = () => useApp((s) => s.report);
const pinText = (p: Pin | null) =>
  p ? `${CAMPUSES[p.campus].short}, ${p.floor} этаж${p.room ? `, ${p.room}` : p.near ? `, рядом: ${p.near}` : ""}` : "";

/* ---------- подсказка на время выбора точки (поверх плана) */
export function ReportPickBar() {
  const picking = useApp((s) => !!s.report?.picking);
  if (!picking) return null;
  return (
    <div className="pick-bar fb-pick">
      <span className="pick-ic"><Icon name="flag" /></span>
      <span className="pick-t"><b>Нажмите на место с неточностью</b><small>можно приблизить план и сменить этаж</small></span>
      <button className="pick-x" onClick={cancelPick}>Отмена</button>
    </div>
  );
}

/* ---------- форма */
export function ReportSheet() {
  const r = useReport();
  const box = useRef<HTMLElement | null>(null);
  const setBox = (el: HTMLElement | null) => { box.current = el; };
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ number: number; url?: string } | null>(null);
  const trap = useRef<HTMLInputElement>(null);
  const pin = r?.pin;

  // на телефоне отмеченное место не должно оказаться под карточкой
  useLayoutEffect(() => {
    if (!pin || !box.current || !isPhone() || r?.picking) return;
    const h = box.current.offsetHeight + 8;
    planCtl.current?.reveal({ x: pin.x - 30, y: pin.y - 30, width: 60, height: 60 }, h);
  }, [pin, r?.picking, done]);

  // на телефоне фокус открыл бы клавиатуру и закрыл бы план: там поле выбирают сами
  useEffect(() => { if (!isPhone()) box.current?.querySelector("textarea")?.focus({ preventScroll: true }); }, [r?.kind]);

  if (!r || r.picking) return null;
  const tgName = tgUsername();
  const problem = check(r);
  const cool = wait();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (problem) return setErr(problem);
    if (!consent) return setErr("Отметьте согласие: обращение публикуется в открытом репозитории.");
    setBusy(true); setErr(null);
    try {
      const res = await sendReport(r, true, trap.current?.value || "");
      setDone(res);
      thanks();
    } catch (x) {
      setErr((x as Error).message);
    } finally { setBusy(false); }
  };

  if (done) {
    return (
      <div className="fb-sheet" role="dialog" aria-label="Обращение отправлено" ref={setBox}>
        <div className="fb-done">
          <span className="fb-done-ic"><Icon name="check" /></span>
          <b>Спасибо, отправлено</b>
          <p>Мы прочитаем и поправим.{done.url && <> Обращение <a href={done.url} target="_blank" rel="noopener">№{done.number}</a> открыто для всех.</>}</p>
          <button className="primary-btn" onClick={closeReport}>Закрыть</button>
        </div>
      </div>
    );
  }

  return (
    <form className="fb-sheet" role="dialog" aria-label="Обращение" onSubmit={submit} ref={setBox} noValidate>
      <div className="fb-head">
        <b>Нашли неточность или сбой?</b>
        <button type="button" className="pk-x" onClick={closeReport} title="Закрыть"><Icon name="close" /></button>
      </div>

      <div className="fb-kinds" role="radiogroup" aria-label="Тип обращения">
        {KINDS.map((k) => (
          <button key={k} type="button" role="radio" aria-checked={r.kind === k} className={cx(r.kind === k && "on")}
            onClick={() => patchReport({ kind: k })}>{KIND_LABEL[k]}</button>
        ))}
      </div>

      {r.kind !== "bug" && (pin ? (
        <div className="fb-where set">
          <span className="fb-where-ic"><Icon name="flag" /></span>
          <span className="fb-where-t"><b>Отмечено на плане</b><small>{pinText(pin)}</small></span>
          <button type="button" className="fb-link" onClick={clearPin}>Убрать</button>
          <button type="button" className="fb-link strong" onClick={startPin}>Изменить</button>
        </div>
      ) : (
        <button type="button" className="fb-mark-btn" onClick={startPin}><Icon name="flag" />Отметить место на плане</button>
      ))}

      <label className="fb-field">
        <textarea value={r.text} rows={3} maxLength={TEXT_MAX + 200} placeholder={HINT[r.kind]}
          onChange={(e) => { patchReport({ text: e.target.value }); setErr(null); }} />
        <small className={cx("fb-count", r.text.length > TEXT_MAX && "over")}>{r.text.length} / {TEXT_MAX}</small>
      </label>

      <label className="fb-field">
        <span className="fb-label">Как с вами связаться <i>необязательно</i></span>
        <input type="text" value={r.contact} maxLength={80} placeholder="@telegram, почта или телефон" autoComplete="off" inputMode="email"
          onChange={(e) => { patchReport({ contact: e.target.value }); setErr(null); }} />
        {!r.contact && tgName && <button type="button" className="fb-link fb-fill" onClick={() => patchReport({ contact: "@" + tgName })}>Подставить @{tgName} из Telegram</button>}
        <small className="fb-warn">Обращение публичное: контакт увидят все, кто откроет его на GitHub. Оставляйте только то, чем готовы поделиться.</small>
      </label>

      {/* ловушка для ботов: людям не видна */}
      <input ref={trap} className="fb-trap" type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" />

      <details className="fb-dev">
        <summary>Что уйдёт вместе с обращением</summary>
        <p>Текст, отметка на плане (этаж и координаты), контакт, если указали, и сведения об устройстве: система и браузер, размер окна и экрана, язык, тема, версия приложения{deviceInfo().tg ? ", версия Telegram" : ""}. IP-адрес и личные данные из календаря не передаются.</p>
      </details>

      <label className="consent-check fb-consent">
        <input type="checkbox" checked={consent} onChange={(e) => { setConsent(e.target.checked); setErr(null); }} />
        <span>Согласен, что обращение целиком опубликуют в открытом репозитории, и принимаю <a href={LEGAL + "consent.html"} target="_blank" rel="noopener">условия обработки</a></span>
      </label>

      {(err || cool > 0) && <div className="form-error" role="alert">{err || `Вы недавно отправляли обращения. Попробуйте через ${cool} мин.`}</div>}
      <button className="primary-btn fb-send" disabled={busy || cool > 0}>{busy ? "Отправляем…" : "Отправить"}</button>
    </form>
  );
}

/* ---------- приглашение: один раз при запуске, после уведомления о статусе сервиса */
export function FeedbackIntro() {
  const [open, setOpen] = useState(false);
  const busy = useApp((s) => s.guide !== null || s.search || !!s.report || s.route.open);
  useEffect(() => {
    if (introSeen()) return;
    // не показываем поверх уведомления о статусе: оно закроется, и придёт наша очередь
    const show = () => { const id = setTimeout(() => setOpen(true), 1200); return () => clearTimeout(id); };
    if (localStorage.getItem("cu.legal") === "1") return show();
    const on = () => { show(); };
    window.addEventListener("cu:legal-done", on, { once: true });
    return () => window.removeEventListener("cu:legal-done", on);
  }, []);
  if (!open || busy) return null;
  const close = () => { markIntroSeen(); setOpen(false); };
  return (
    <div className="legal-note fb-intro" role="region" aria-label="Обратная связь">
      <p>
        <b>Нашли неточность на плане?</b> Отметьте место на карте и напишите, что поправить. Сюда же можно написать,
        если в приложении что-то сломалось или не хватает.
      </p>
      <div className="fb-intro-btns">
        <button className="primary-btn" onClick={() => { close(); openReport({ kind: "map" }); }}>Сообщить</button>
        <button className="ghost-btn" onClick={close}>Позже</button>
      </div>
    </div>
  );
}
