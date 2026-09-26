/* Подключение Яндекс Календаря: карточка «зачем», пошаговая инструкция с анимацией и профиль */
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { account, useAccountVersion } from "../lib/account";
import { getState, useApp, setState } from "../lib/store";
import { closeGuide, openGuide, setView, toast } from "../lib/actions";
import { haptic } from "../lib/telegram";
import { cx, dayFmt, fmt, iso, todayIso } from "../lib/util";
import { Icon, type IconName } from "./icons";

const APP_PASSWORDS = "https://id.yandex.ru/security/app-passwords";
const HERO = import.meta.env.BASE_URL + "img/connect-hero.webp";
// последний слайд инструкции - форма входа
const FORM_SLIDE = 4;

// обработчикам событий нужен текущий слайд без перерисовки
const getSlide = () => getState().guide ?? 0;

const PERKS: [IconName, string, string][] = [
  ["cal", "Только твои пары", "Без чужих потоков и групп"],
  ["route", "Аудитория и маршрут", "В один тап от любой пары"],
  ["video", "Ссылки на звонки", "Онлайн-занятия открываются сразу"],
  ["check", "Приду / не приду", "Отметки, как в календаре на телефоне"],
];

/* ---------- карточка «зачем подключать» */
export function ConnectCard() {
  useAccountVersion();
  return (
    <div className="connect-card">
      <div className="cc-hero">
        <div className="cc-hero-text">
          <span className="cc-badge"><Icon name="cal" />Яндекс Календарь</span>
          <h3>Подключи свой календарь ЦУ</h3>
          <p>И расписание станет личным</p>
        </div>
        <img className="cc-hero-img" src={HERO} alt="" width={440} height={603} draggable={false} />
      </div>
      <ul className="cc-perks">
        {PERKS.map(([icon, title, sub]) => (
          <li key={title}><span className="lc-ic lc-violet"><Icon name={icon} /></span><span className="lc-text"><b>{title}</b><small>{sub}</small></span></li>
        ))}
      </ul>
      {account.error && <div className="form-error">{account.error}</div>}
      <div className="cc-actions">
        <button className="primary-btn cc-go" onClick={() => openGuide(0)}>Как подключить<Icon name="next" /></button>
        <button className="cc-have" onClick={() => openGuide(FORM_SLIDE)}>У меня уже есть пароль приложения</button>
      </div>
      <p className="fine">Пароль приложения открывает только календарь. Отозвать его можно в Яндекс ID в любой момент.</p>
    </div>
  );
}

/* ---------- форма входа */
function LoginForm({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pass = useRef<HTMLInputElement>(null);
  const canPaste = typeof navigator.clipboard?.readText === "function";
  const paste = async () => {
    try {
      const t = (await navigator.clipboard.readText()).replace(/\s+/g, "");
      if (t && pass.current) { pass.current.value = t; haptic.select(); }
    } catch { pass.current?.focus(); }
  };
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setBusy(true); setErr(null);
    try {
      await account.loginWithPassword(String(data.get("login")).trim(), String(data.get("password")).replace(/\s+/g, ""));
      haptic.ok();
      setState({ mine: true });
      toast("Календарь подключён");
      onDone();
    } catch (x) {
      haptic.error();
      const ex = x as { code?: string; message: string };
      setErr(ex.code === "auth" ? "Яндекс не принял почту или пароль. Нужен именно пароль приложения для календаря." : ex.message);
      setBusy(false);
    }
  };
  return (
    <form className="login-form" autoComplete="on" onSubmit={submit}>
      <label>Почта ЦУ<input name="login" type="email" inputMode="email" autoComplete="username" placeholder="i.ivanov@edu.centraluniversity.ru" required /></label>
      <label>Пароль приложения
        <span className="pass-field">
          <input ref={pass} name="password" type="password" autoComplete="current-password" placeholder="16 букв от Яндекса" required />
          {canPaste && <button type="button" className="paste-btn" onClick={paste}>Вставить</button>}
        </span>
      </label>
      {err && <div className="form-error">{err}</div>}
      <button type="submit" className="primary-btn" disabled={busy}>{busy ? "Проверяю…" : "Подключить"}</button>
    </form>
  );
}

/* ---------- макеты экранов Яндекс ID для слайдов */
const Finger = () => <span className="g-finger" aria-hidden="true"><i /></span>;

function Row({ icon, title, sub, plus, arrow, tap }: { icon: IconName; title: string; sub?: string; plus?: boolean; arrow?: boolean; tap?: boolean }) {
  return (
    <div className={cx("y-row", tap && "g-target")}>
      <span className="y-ic"><Icon name={icon} /></span>
      <span className="y-txt"><b>{title}</b>{sub && <small>{sub}</small>}</span>
      {plus && <span className="y-plus">+</span>}
      {arrow && <span className="y-arrow"><Icon name="next" /></span>}
    </div>
  );
}

function MockAccess() {
  return (
    <div className="y-screen">
      <div className="y-logo">Яндекс <i>ID</i></div>
      <div className="y-tabs"><span>Главная</span><span>Данные</span><span className="on"><Icon name="shield" />Безопасность</span></div>
      <div className="y-h">Доступ к вашим данным</div>
      <Row icon="user" title="Добавить внешние аккаунты" arrow />
      <Row icon="route" title="Управлять доступами" arrow />
      <Row icon="key" title="Пароли приложений" arrow tap />
      <Finger />
    </div>
  );
}

function MockKinds() {
  return (
    <div className="y-screen">
      <div className="y-h">Создать пароль приложения</div>
      <div className="y-sub">Выберите, к каким данным нужно предоставить доступ</div>
      <Row icon="screen" title="Почта" sub="IMAP, POP3, SMTP" plus />
      <Row icon="book" title="Контакты" sub="CardDAV" plus />
      <Row icon="sched" title="Календарь" sub="CalDAV" plus tap />
      <Row icon="walk" title="Автомагнитолы" sub="Музыка, Радио" plus />
      <Finger />
    </div>
  );
}

// имя пароля печатается по буквам, пока слайд на экране
function useTyping(text: string, on: boolean, period = 4800) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!on) { setN(0); return; }
    const t0 = performance.now();
    const id = setInterval(() => {
      const t = (performance.now() - t0) % period;
      setN(Math.max(0, Math.min(text.length, Math.floor((t - 500) / 130))));
    }, 50);
    return () => clearInterval(id);
  }, [on, text, period]);
  return text.slice(0, n);
}

function Steps({ n }: { n: number }) {
  return <div className="y-steps"><span>{n} из 2</span><i className={n === 2 ? "full" : ""} /></div>;
}

function MockName({ on }: { on: boolean }) {
  const typed = useTyping("cu-plan", on);
  return (
    <div className="y-screen y-dim">
      <div className="y-modal">
        <Steps n={1} />
        <div className="y-title">Новый пароль приложения</div>
        <div className="y-sub c">Календарь · CalDAV</div>
        <div className="y-input"><small>Придумайте имя пароля</small><span>{typed}<i className="caret" /></span></div>
        <div className="y-btn g-target">Далее</div>
      </div>
      <Finger />
    </div>
  );
}

function MockCopy() {
  return (
    <div className="y-screen y-dim">
      <div className="y-modal">
        <Steps n={2} />
        <div className="y-title">Скопируйте и сохраните пароль</div>
        <div className="y-sub c">Он показывается один раз</div>
        <div className="y-pass">
          <span className="y-key"><Icon name="key" /></span>
          <span className="y-code">kqzvmrtwplhnxbye</span>
          <span className="y-copy g-target"><Icon name="copy" /><em>Скопировано</em></span>
        </div>
        <div className="y-btn ghost">Закрыть</div>
      </div>
      <Finger />
    </div>
  );
}

interface Slide { title: string; text: ReactNode; mock?: (on: boolean) => ReactNode; cls?: string }

const SLIDES: Slide[] = [
  {
    title: "Открой пароли приложений",
    text: <>Войди в Яндекс ID под почтой ЦУ. В разделе <b>Безопасность</b> выбери <b>Пароли приложений</b>.</>,
    mock: () => <MockAccess />, cls: "s-access",
  },
  {
    title: "Выбери «Календарь»",
    text: <>Внизу страницы, в блоке <b>Создать пароль приложения</b>, нажми на <b>Календарь · CalDAV</b>.</>,
    mock: () => <MockKinds />, cls: "s-kinds",
  },
  {
    title: "Назови пароль",
    text: <>Любое имя, чтобы потом узнать его в списке. Например, <b>cu-plan</b>. Нажми <b>Далее</b>.</>,
    mock: (on) => <MockName on={on} />, cls: "s-name",
  },
  {
    title: "Скопируй пароль",
    text: <>Яндекс покажет 16 букв <b>только один раз</b>. Нажми на значок копирования и возвращайся сюда.</>,
    mock: () => <MockCopy />, cls: "s-copy",
  },
  {
    title: "Вставь пароль",
    text: <>Почта ЦУ и только что скопированный пароль. Пароль приложения открывает только календарь.</>,
  },
];

/* ---------- инструкция: слайды листаются кнопками, свайпом и стрелками */
export function ConnectGuide() {
  const slide = useApp((s) => s.guide);
  const [closing, setClosing] = useState(false);
  const track = useRef<HTMLDivElement>(null);
  const open = slide !== null;
  const i = slide ?? 0;
  const last = SLIDES.length - 1;

  const go = (n: number) => {
    const next = Math.max(0, Math.min(last, n));
    if (next !== getSlide()) { haptic.select(); setState({ guide: next }); }
  };
  const close = () => {
    setClosing(true);
    setTimeout(() => { setClosing(false); closeGuide(); }, 200);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      if (e.key === "ArrowRight") go(getSlide() + 1);
      else if (e.key === "ArrowLeft") go(getSlide() - 1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // палец в макете ведём к цели нажатия: координаты считаем по вёрстке, а не на глаз
  useLayoutEffect(() => {
    const el = track.current;
    if (!el) return;
    const place = () => {
      for (const scr of el.querySelectorAll<HTMLElement>(".y-screen")) {
        const t = scr.querySelector<HTMLElement>(".g-target");
        if (!t) continue;
        const a = scr.getBoundingClientRect(), b = t.getBoundingClientRect();
        // строку нажимаем ближе к правому краю, кнопку - по центру
        const x = t.classList.contains("y-row") ? b.left + b.width * 0.7 : b.left + b.width / 2;
        scr.style.setProperty("--fx", `${Math.round(x - a.left)}px`);
        scr.style.setProperty("--fy", `${Math.round(b.top + b.height / 2 - a.top)}px`);
      }
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  // свайп по слайдам: лента едет за пальцем
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    let s: { id: number; x: number; y: number; dx: number; on: boolean } | null = null;
    const down = (e: PointerEvent) => {
      if (e.pointerType === "mouse" || (e.target as Element).closest("input, button, a")) return;
      s = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, on: false };
    };
    const move = (e: PointerEvent) => {
      if (!s || e.pointerId !== s.id) return;
      const dx = e.clientX - s.x, dy = e.clientY - s.y;
      if (!s.on) {
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { s = null; return; }
        if (Math.abs(dx) < 10) return;
        s.on = true;
        el.setPointerCapture(e.pointerId);
        el.style.transition = "none";
      }
      const n = getSlide();
      // на краях лента тянется с сопротивлением
      s.dx = (n === 0 && dx > 0) || (n === last && dx < 0) ? dx / 3 : dx;
      el.style.transform = `translateX(calc(${-n * 100}% + ${s.dx}px))`;
    };
    const up = (e: PointerEvent) => {
      if (!s || e.pointerId !== s.id) return;
      const { on, dx } = s;
      s = null;
      if (!on) return;
      el.style.transition = "";
      const n = getSlide();
      if (e.type === "pointerup" && Math.abs(dx) > 50) go(n + (dx < 0 ? 1 : -1));
      el.style.transform = `translateX(${-getSlide() * 100}%)`;
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className={cx("guide", closing && "closing")} role="dialog" aria-modal="true" aria-label="Как подключить Яндекс Календарь"
      onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="guide-sheet">
        <div className="guide-head">
          <div className="guide-dots" aria-label={`Шаг ${i + 1} из ${SLIDES.length}`}>
            {SLIDES.map((_, n) => (
              <button key={n} className={cx(n === i && "on", n < i && "done")} onClick={() => go(n)} aria-label={`Шаг ${n + 1}`} />
            ))}
          </div>
          <span className="guide-count">{i + 1} из {SLIDES.length}</span>
          <button className="icon-btn guide-close" onClick={close} title="Закрыть"><Icon name="close" /></button>
        </div>
        <div className="guide-view">
          <div className="guide-track" ref={track} style={{ transform: `translateX(${-i * 100}%)` }}>
            {SLIDES.map((s, n) => (
              <section key={n} className={cx("gs", s.cls, n === i && "on")} aria-hidden={n !== i}>
                {s.mock ? <div className="gs-stage">{s.mock(n === i)}</div> : (
                  <div className="gs-stage gs-done"><img src={HERO} alt="" draggable={false} /></div>
                )}
                <div className="gs-text">
                  <span className="gs-num">Шаг {n + 1}</span>
                  <h3>{s.title}</h3>
                  <p>{s.text}</p>
                  {n === 0 && <a className="gs-link" href={APP_PASSWORDS} target="_blank" rel="noopener">Открыть Яндекс ID<Icon name="ext" /></a>}
                  {n === FORM_SLIDE && <LoginForm onDone={close} />}
                </div>
              </section>
            ))}
          </div>
        </div>
        <div className="guide-nav">
          <button className="ghost-btn" onClick={() => (i ? go(i - 1) : close())}>{i ? "Назад" : "Закрыть"}</button>
          {i < last && <button className="primary-btn" onClick={() => go(i + 1)}>{i === last - 1 ? "Пароль скопирован" : "Далее"}</button>}
        </div>
      </div>
    </div>
  );
}

/* ---------- профиль */
function syncLine() {
  if (account.syncing) return "Обновляю…";
  if (!account.fetchedAt) return "";
  const d = new Date(account.fetchedAt);
  const today = iso(d) === todayIso();
  return `Обновлено ${today ? "" : dayFmt.format(d) + ", "}в ${fmt(d.getHours() * 60 + d.getMinutes())}`;
}

function initials(name: string) {
  const w = name.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return ((w[0]?.[0] || "") + (w[1]?.[0] || "")).toUpperCase() || "?";
}

export function Profile() {
  useAccountVersion();
  if (!account.enabled) return null;
  const u = account.user;
  return (
    <section className="profile">
      <h3 className="block-title">Профиль</h3>
      {!u ? <ConnectCard /> : (
        <div className="profile-card">
          <div className="pc-top">
            <span className="pc-ava">{initials(u.name || u.email)}</span>
            <span className="lc-text"><b>{u.name || u.email}</b>{u.name && <small>{u.email}</small>}</span>
          </div>
          <div className={cx("pc-status", account.error && "err")}>
            <span className="pc-dot" />
            <span className="pc-st-text"><b>{account.error ? "Календарь не обновился" : "Яндекс Календарь подключён"}</b><small>{account.error || syncLine()}</small></span>
            <button className={cx("icon-btn sync-btn", account.syncing && "spin")} title="Обновить из календаря" onClick={() => account.sync({ force: true })}><Icon name="sync" /></button>
          </div>
          <div className="pc-actions">
            <button className="primary-btn" onClick={() => { setState({ mine: true }); setView("list"); }}><Icon name="cal" />Мои пары</button>
            <button className="ghost-btn" onClick={() => { account.logout(); toast("Календарь отключён. Пароль приложения можно отозвать в Яндекс ID"); }}>Выйти</button>
          </div>
          <a className="pc-link" href={APP_PASSWORDS} target="_blank" rel="noopener">Пароли приложений в Яндекс ID<Icon name="ext" /></a>
        </div>
      )}
    </section>
  );
}
