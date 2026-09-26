/* Мои пары: вход по паролю приложения, список с отметками «приду / не приду» */
import { useEffect, useState, type FormEvent } from "react";
import { account, useAccountVersion, type Partstat } from "../lib/account";
import { myEvents, type MyEv } from "../lib/mine";
import { useApp, setState } from "../lib/store";
import { openRoute, pickRoom, setMode, toast } from "../lib/actions";
import { haptic } from "../lib/telegram";
import { cx, dayFmt, fmt, iso, todayIso } from "../lib/util";
import { evKind } from "../lib/schedule";
import { Icon } from "./icons";
import { Seg } from "./Seg";

const PARTSTAT: [Partstat, string, string][] = [
  ["ACCEPTED", "Приду", "yes"],
  ["TENTATIVE", "Возможно", "maybe"],
  ["DECLINED", "Не приду", "no"],
];

function LoginCard() {
  useAccountVersion();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = e.currentTarget, data = new FormData(f);
    setBusy(true); setErr(null);
    try {
      await account.loginWithPassword(String(data.get("login")), String(data.get("password")));
      haptic.ok();
      setState({ mine: true });
    } catch (x) {
      const ex = x as { code?: string; message: string };
      setErr(ex.code === "auth" ? "Яндекс не принял почту или пароль. Нужен именно пароль приложения для календаря." : ex.message);
      setBusy(false);
    }
  };
  return (
    <div className="login-card">
      <div className="lc-top"><span className="lc-ic lc-violet"><Icon name="cal" /></span>
        <div className="lc-text"><b>Мои пары</b><small>Из вашего Яндекс Календаря ЦУ</small></div></div>
      <p>Только ваши пары с аудиториями на плане, ссылки на звонки и отметки «приду / не приду», как в календаре на телефоне.</p>
      {account.error && <div className="form-error">{account.error}</div>}
      <form className="login-form" autoComplete="on" onSubmit={submit}>
        <label>Почта ЦУ<input name="login" type="email" inputMode="email" autoComplete="username" placeholder="i.ivanov@edu.centraluniversity.ru" required /></label>
        <label>Пароль приложения<input name="password" type="password" autoComplete="current-password" placeholder="16 символов от Яндекса" required /></label>
        {err && <div className="form-error">{err}</div>}
        <button type="submit" className="primary-btn" disabled={busy}>{busy ? "Проверяю…" : "Войти"}</button>
      </form>
      <details className="howto">
        <summary>Где взять пароль приложения</summary>
        <ol>
          <li>Откройте <a href="https://id.yandex.ru/security/app-passwords" target="_blank" rel="noopener">Яндекс ID → Пароли приложений</a>, войдите через аккаунт ЦУ.</li>
          <li>Нажмите «Календарь» и назовите пароль, например «Расписание ЦУ».</li>
          <li>Скопируйте пароль, который покажет Яндекс, и вставьте сюда.</li>
        </ol>
        <p>Отозвать доступ можно там же в любой момент.</p>
      </details>
      <p className="fine">Пароль приложения открывает только календарь. На устройстве хранится зашифрованный ключ сессии, пароль в открытом виде нигде не сохраняется.</p>
    </div>
  );
}

function syncLine() {
  if (account.syncing) return "Обновляю…";
  if (account.error) return account.error;
  if (!account.fetchedAt) return "";
  const d = new Date(account.fetchedAt);
  const today = iso(d) === todayIso();
  return `Обновлено ${today ? "" : dayFmt.format(d) + ", "}в ${fmt(d.getHours() * 60 + d.getMinutes())}`;
}

async function mark(ev: MyEv, partstat: Partstat, scope: "one" | "series") {
  try {
    await account.rsvp(ev, partstat, scope);
    haptic.ok();
    if (scope === "series") toast("Отмечено для всех будущих занятий серии");
  } catch (e) {
    haptic.error();
    const ex = e as { code?: string; message: string };
    toast(ex.code === "forbidden" ? "Яндекс не разрешил изменить это событие" : `Не удалось отметить: ${ex.message}`);
  }
}

function MineItem({ e, t, isToday, hint, onMark, onSeries }: {
  e: MyEv; t: number; isToday: boolean; hint: Partstat | null;
  onMark: (v: Partstat) => void; onSeries: (v: Partstat) => void;
}) {
  const room = useApp((s) => s.room);
  const cls = isToday && e.e <= t ? "past" : isToday && e.s <= t ? "now" : "";
  const kind = e.type ? evKind(e.type) : "";
  const meta = [e.teachers, e.timetable ? "" : e.calendar].filter(Boolean).join(" · ");
  const busy = account.isPending(e.id);
  return (
    <li className={cx("ev my", cls, e.partstat === "DECLINED" && "declined")}>
      {e.allDay ? <div className="t">весь<span>день</span></div> : <div className="t">{e.startHM}<span>{e.endHM}</span></div>}
      <div>
        <div className="title">{e.title}</div>
        <div className="meta">
          {e.online ? <span className="online-tag">Онлайн</span> : e.rooms.length ? <>
            {e.rooms.map((r) => e.known.includes(r)
              ? <button key={r} className={cx("room", r === room && "sel")} onClick={() => pickRoom(r)} title="Показать на плане">{r}</button>
              : <span key={r} className="room off">{r}</span>)}
            {e.campus === "DUCAT" && <span className="campus-tag">Дукат</span>}
            {e.campus === "OTHER" && <span className="campus-tag">{e.campusName || ""}</span>}
          </> : e.location ? <span>{e.location}</span> : null}
          {e.type && <span className={cx("kind", kind)}>{e.type}</span>}
          {meta && <span>{meta}</span>}
        </div>
        {(e.url || e.partstat || e.known.length > 0) && (
          <div className="ev-actions">
            {e.url && <a className={cx("join", e.online && "primary")} href={e.url} target="_blank" rel="noopener"><Icon name="video" />{e.online ? "Подключиться" : "Звонок"}</a>}
            {e.known.length > 0 && <button className="join" onClick={() => openRoute({ to: "r:" + e.known[0] })}><Icon name="route" />Как пройти</button>}
            {e.partstat && (
              <div className={cx("rsvp", busy && "busy")} role="group" aria-label="Присутствие">
                {PARTSTAT.map(([v, label, c]) => (
                  <button key={v} className={cx(c, e.partstat === v && "on")} aria-pressed={e.partstat === v} disabled={busy}
                    onClick={() => e.partstat !== v && onMark(v)}>{label}</button>
                ))}
              </div>
            )}
          </div>
        )}
        {hint && <div className="rsvp-hint">Отмечено для этого занятия. <button onClick={() => onSeries(hint)}>Отметить всю серию</button></div>}
      </div>
    </li>
  );
}

function MineList() {
  useAccountVersion();
  const date = useApp((s) => s.date), t = useApp((s) => s.t);
  // предложить отметить всю серию после отметки одного повторяющегося занятия
  const [hint, setHint] = useState<{ id: string; partstat: Partstat } | null>(null);
  useEffect(() => { account.ensure(date); }, [date]);
  useEffect(() => {
    if (!hint) return;
    const id = setTimeout(() => setHint(null), 12000);
    return () => clearTimeout(id);
  }, [hint]);
  const evs = myEvents(date);
  const loading = !account.covers(date);
  const isToday = date === todayIso();
  const items = [];
  let lineDone = !isToday;
  for (const e of evs) {
    if (!lineDone && e.s > t) { items.push(<li key="now" className="now-line">{fmt(t)}</li>); lineDone = true; }
    items.push(<MineItem key={e.id} e={e} t={t} isToday={isToday} hint={hint && hint.id === e.id ? hint.partstat : null}
      onMark={(v) => { setHint(e.recurring ? { id: e.id, partstat: v } : null); mark(e, v, "one"); }}
      onSeries={(v) => { setHint(null); mark(e, v, "series"); }} />);
  }
  return (
    <div className="mine-part">
      <div className="list-head">
        <h2>Мои пары{loading ? "" : " · " + evs.length}</h2>
        <button className={cx("icon-btn sync-btn", account.syncing && "spin")} title="Обновить из календаря" onClick={() => account.sync({ force: true })}><Icon name="sync" /></button>
      </div>
      <div className={cx("sync-state", account.error && "err")}>{syncLine()}</div>
      <ol className="events">
        {loading ? <li className="empty">Загружаю расписание на эту дату…</li> : !evs.length ? <li className="empty">В этот день пар нет</li> : null}
        {items}
      </ol>
      <div className="account-line">
        <span>{account.user!.name || account.user!.email}</span>
        <button onClick={() => { account.logout(); toast("Вы вышли. Пароль приложения можно отозвать в Яндекс ID"); }}>Выйти</button>
      </div>
    </div>
  );
}

export function MineBar() {
  const mine = useApp((s) => s.mine);
  if (!account.enabled) return null;
  return (
    <div className="mode-bar">
      <Seg value={mine ? "mine" : "all"} onChange={(v) => setMode(v === "mine")} label="Чьи пары показывать"
        items={[{ value: "mine", label: "Мои пары" }, { value: "all", label: "Все пары" }]} />
    </div>
  );
}

export function MinePanel() {
  useAccountVersion();
  return account.user ? <MineList /> : <LoginCard />;
}
