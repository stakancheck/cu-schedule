/* Левая часть: панель управления планом и сам план с карточками поверх */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CAMPUSES, autoSummary, floorNums } from "../lib/schedule";
import { useApp } from "../lib/store";
import { openRoute, planCtl, setCampus, setFloor } from "../lib/actions";
import { inTg, syncTgColors, tg } from "../lib/telegram";
import { isPhone, lsGet, lsSet } from "../lib/util";
import { PlanRenderer } from "../plan/PlanRenderer";
import { Seg } from "./Seg";
import { Icon } from "./icons";
import { RoomPeek } from "./Room";
import { PickBar, RouteSheet } from "./Route";

// Тема: как в системе -> светлая -> тёмная
type Theme = "auto" | "light" | "dark";
const THEMES: Record<Theme, string> = { auto: "как в системе", light: "светлая", dark: "тёмная" };
function applyTheme(mode: Theme) {
  const root = document.documentElement;
  // «как в системе» внутри Telegram = тема Telegram, а не ОС
  if (mode === "auto") {
    if (inTg) root.dataset.theme = tg!.colorScheme === "dark" ? "dark" : "light";
    else delete root.dataset.theme;
  } else root.dataset.theme = mode;
  lsSet("theme", mode === "auto" ? null : mode);
  syncTgColors();
}

function ThemeButton() {
  const [mode, setMode] = useState<Theme>(() => { const t = lsGet("theme"); return t === "light" || t === "dark" ? t : "auto"; });
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => { applyTheme(mode); }, [mode]);
  useEffect(() => {
    if (inTg) tg!.onEvent("themeChanged", () => { if (modeRef.current === "auto") applyTheme("auto"); });
  }, []);
  const order: Theme[] = ["auto", "light", "dark"];
  return (
    <button className="icon-btn" id="themeBtn" data-mode={mode} title={`Тема: ${THEMES[mode]}`}
      onClick={() => setMode(order[(order.indexOf(mode) + 1) % 3])}>
      <svg className="ic ic-auto" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" /></svg>
      <svg className="ic ic-light" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
      <svg className="ic ic-dark" viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" /></svg>
    </button>
  );
}

function PlanBar() {
  const campusId = useApp((s) => s.campus), floor = useApp((s) => s.floor), angle = useApp((s) => s.angle);
  const route = useApp((s) => s.route);
  const c = CAMPUSES[campusId];
  // этажи, по которым идёт выбранный маршрут
  const o = route.open && route.options && route.campus === campusId ? route.options[route.sel] : null;
  const rtFloors = new Set(o ? o.steps.map((s) => s.floor) : []);
  const nums = floorNums(c);
  const rotate = (a: number) => planCtl.current?.rotateTo(a);
  return (
    <header className="plan-bar">
      {/* на телефоне колонка поверх плана справа */}
      <div className="nav-col">
        <Seg value={campusId} onChange={setCampus} label="Кампус"
          items={Object.values(CAMPUSES).map((k) => ({ value: k.id, label: k.short }))} />
        <Seg value={floor} onChange={setFloor} label="Этаж" className={nums.length > 4 ? "many" : ""}
          items={nums.map((n) => ({ value: n, title: `${n} этаж`, className: rtFloors.has(n) ? "has-route" : "", label: <>{n}<span className="fl-w"> этаж</span></> }))} />
      </div>
      <div className="spacer" />
      <div className="tools">
        <button className="icon-btn" id="rotL" title="Повернуть против часовой" onClick={() => rotate(angle - 90)}><Icon name="rotL" /></button>
        <button className="compass" id="compass" title="Север наверх" onClick={() => {
          // на телефоне компас - единственная кнопка поворота, крутит по часовой
          if (isPhone()) return rotate(angle + 90);
          const a = angle % 360;
          rotate(angle - (a > 180 ? a - 360 : a < -180 ? a + 360 : a));
        }}>
          <svg viewBox="-20 -20 40 40"><path className="rot-hint" d="M11.3,-11.3 A16,16 0 0 1 4.1,15.5 M4.1,15.5 L8.8,17.3 M4.1,15.5 L7.2,11.5" /><g className="needle-wrap"><g id="needle"><path className="n" d="M0,-15 L5,0 L-5,0Z" /><path className="s" d="M0,15 L5,0 L-5,0Z" /></g><text id="compassN" y="-4.5" x="0">С</text></g></svg>
        </button>
        <button className="icon-btn" id="rotR" title="Повернуть по часовой" onClick={() => rotate(angle + 90)}><Icon name="rotR" /></button>
        <span className="sep" />
        <button className="icon-btn" id="zoomOut" title="Отдалить" onClick={() => planCtl.current?.zoomBy(1 / 1.4)}><Icon name="minus" /></button>
        <button className="icon-btn" id="zoomIn" title="Приблизить" onClick={() => planCtl.current?.zoomBy(1.4)}><Icon name="plus" /></button>
        <span className="sep" />
        <ThemeButton />
      </div>
      <div className="floor-title">
        <div className="floor-n">Этаж {floor}</div>
        <div className="floor-sum">{autoSummary(c, floor)}</div>
      </div>
    </header>
  );
}

function PlanView() {
  const svg = useRef<SVGSVGElement>(null), wrap = useRef<HTMLDivElement>(null), tip = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const r = new PlanRenderer(svg.current!, wrap.current!, tip.current!);
    return () => r.destroy();
  }, []);
  const routeOpen = useApp((s) => s.route.open);
  return (
    <div className="plan-wrap" id="planWrap" ref={wrap}>
      <svg id="plan" ref={svg} xmlns="http://www.w3.org/2000/svg" />
      <div className="legend">
        <span><i className="sw free" />Свободна</span>
        <span><i className="sw soon" />Скоро пара</span>
        <span><i className="sw busy" />Идёт пара</span>
        <span><i className="sw kitchen" />Кухни, кафе</span>
        <span><i className="sw staff" />Сотрудники</span>
      </div>
      <div className="tooltip" ref={tip} hidden />
      {!routeOpen && <RoomPeek />}
      {!routeOpen && (
        <button className="route-fab" title="Построить маршрут" onClick={() => openRoute()}>
          <Icon name="route" /><span>Маршрут</span>
        </button>
      )}
      <PickBar />
      <RouteSheet />
    </div>
  );
}

export function PlanPane() {
  return (
    <section className="plan-pane">
      <PlanBar />
      <PlanView />
    </section>
  );
}
