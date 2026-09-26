/* Нижнее меню телефона, «Полезное», уведомление */
import { useEffect, useRef } from "react";
import { useApp, type View } from "../lib/store";
import { setView } from "../lib/actions";
import { cx } from "../lib/util";
import { Icon, type IconName } from "./icons";

const TABS: [View, string, IconName][] = [["plan", "План", "map"], ["list", "Расписание", "list"], ["profile", "Профиль", "user"]];

export function TabBar() {
  const view = useApp((s) => s.view);
  const lens = useRef<HTMLSpanElement>(null);
  const first = useRef(true);
  useEffect(() => {
    // «линза» перетекает под выбранную вкладку с лёгким растяжением
    const l = lens.current!;
    l.style.transform = `translateX(${TABS.findIndex((t) => t[0] === view) * 100}%)`;
    if (first.current) { first.current = false; return; }
    l.classList.remove("stretch"); void l.offsetWidth; l.classList.add("stretch");
  }, [view]);
  return (
    <nav className="tabbar" aria-label="Разделы">
      <span className="tab-lens" ref={lens} />
      {TABS.map(([v, label, icon]) => (
        <button key={v} className={cx(v === view && "on")} onClick={() => setView(v)}>
          <Icon name={icon} /><span>{label}</span>
        </button>
      ))}
    </nav>
  );
}

const LINKS: { href: string; icon: IconName; color: string; title: string; sub: string }[] = [
  { href: "https://note.cu.ru/space/dff5a22f-c6bf-4db2-9138-b7f830e4e921/article/65f8d9d0-35f7-4de1-9f05-b347a08cfd22", icon: "book", color: "lc-violet", title: "Хендбук бакалавриата", sub: "Правила, оценивание, учебный процесс" },
  { href: "https://note.cu.ru/space/dff5a22f-c6bf-4db2-9138-b7f830e4e921/article/b2378459-32df-42cb-8960-16ee4b208c18", icon: "cap", color: "lc-cyan", title: "Хендбук магистратуры", sub: "Правила, оценивание, учебный процесс" },
  { href: "https://my.centraluniversity.ru/", icon: "screen", color: "lc-green", title: "LMS", sub: "my.centraluniversity.ru: курсы, задания, оценки" },
  { href: "https://cu-schedule.ru/", icon: "sched", color: "lc-orange", title: "Расписание целиком", sub: "cu-schedule.ru: фильтры и выгрузка в Excel" },
];

export function Useful() {
  return (
    <>
      <section className="useful">
        <h3 className="block-title">Полезное</h3>
        {LINKS.map((l) => (
          <a key={l.href} className="link-card" href={l.href} target="_blank" rel="noopener">
            <span className={cx("lc-ic", l.color)}><Icon name={l.icon} /></span>
            <span className="lc-text"><b>{l.title}</b><small>{l.sub}</small></span>
            <span className="lc-arrow">↗</span>
          </a>
        ))}
      </section>
      <footer className="credits">
        Благодарность можно выразить: <a href="https://t.me/stakancheck" target="_blank" rel="noopener">@stakancheck</a>
      </footer>
    </>
  );
}

export function Toast() {
  const toast = useApp((s) => s.toast);
  if (!toast) return null;
  return <div className="toast" key={toast.id} role="status" aria-live="polite">{toast.text}</div>;
}
