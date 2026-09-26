/* Левая часть: панель управления планом и сам план с карточками поверх */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CAMPUSES, autoSummary, floorNums } from "../lib/schedule";
import { useApp } from "../lib/store";
import { openRoute, planCtl, setCampus, setFloor } from "../lib/actions";
import { inTg, syncTgColors, tg } from "../lib/telegram";
import { cx, lsGet, lsSet } from "../lib/util";
import { PlanRenderer } from "../plan/PlanRenderer";
import { Seg } from "./Seg";
import { Icon } from "./icons";
import { RoomPeek } from "./Room";
import { PlacePeek } from "./Place";
import { SearchButton } from "./Search";
import { TimeIsland } from "./TimeIsland";
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

// Компас: нажатие - север наверх, перетаскивание по кругу - поворот плана на любой угол
const TICKS = Array.from({ length: 12 }, (_, i) => i * 30).filter((d) => d);
function Compass() {
  const angle = useApp((s) => s.angle);
  // start - угол плана в начале, acc - сколько провернули пальцем
  const drag = useRef<{ cx: number; cy: number; x: number; y: number; last: number; start: number; acc: number; moved: boolean } | null>(null);
  const ptrAngle = (cx: number, cy: number, e: React.PointerEvent) => (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI;
  return (
    <button className="compass" id="compass" title="Север наверх. Потяните по кругу, чтобы повернуть план"
      onPointerDown={(e) => {
        const b = e.currentTarget.getBoundingClientRect();
        const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
        drag.current = { cx, cy, x: e.clientX, y: e.clientY, last: ptrAngle(cx, cy, e), start: angle, acc: 0, moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4)) return;
        d.moved = true;
        const a = ptrAngle(d.cx, d.cy, e);
        d.acc += ((((a - d.last + 180) % 360) + 360) % 360) - 180;
        d.last = a;
        planCtl.current?.turn(d.start + d.acc);
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        if (d?.moved) return planCtl.current?.settle();
        const a = angle % 360;
        planCtl.current?.rotateTo(angle - (a > 180 ? a - 360 : a < -180 ? a + 360 : a));
      }}
      onPointerCancel={() => { if (drag.current?.moved) planCtl.current?.settle(); drag.current = null; }}>
      <svg viewBox="-20 -20 40 40" aria-hidden="true">
        <g id="dial">
          {TICKS.map((d) => <line key={d} className={d % 90 ? "tk" : "tk main"} y1={d % 90 ? -15.5 : -14.5} y2={-17} transform={`rotate(${d})`} />)}
          <path className="n" d="M0,-8.5 L2.6,0 L-2.6,0Z" />
          <path className="s" d="M0,8.5 L2.6,0 L-2.6,0Z" />
          <circle className="hub" r="1.3" />
          <text id="compassN">С</text>
        </g>
      </svg>
    </button>
  );
}

// Подпись этажа в одну строку: если не влезает, текст медленно ездит туда-обратно
function Marquee({ text, className }: { text: string; className?: string }) {
  const box = useRef<HTMLDivElement>(null), inner = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    const b = box.current!, i = inner.current!;
    const measure = () => setShift(Math.max(0, Math.ceil(i.scrollWidth - b.clientWidth)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(b);
    return () => ro.disconnect();
  }, [text]);
  return (
    <div className={cx("marquee", shift > 0 && "run", className)} ref={box} title={shift > 0 ? text : undefined}>
      <span key={text} ref={inner} style={shift > 0 ? ({ "--shift": `${-shift}px`, "--dur": `${Math.max(6, shift / 25 + 4)}s` } as React.CSSProperties) : undefined}>{text}</span>
    </div>
  );
}

function PlanBar() {
  const campusId = useApp((s) => s.campus), floor = useApp((s) => s.floor);
  const route = useApp((s) => s.route);
  const c = CAMPUSES[campusId];
  // этажи, по которым идёт выбранный маршрут
  const o = route.open && route.options ? route.options[route.sel] : null;
  const rtFloors = new Set(o ? o.steps.filter((s) => (s.campus || route.campus) === campusId && s.leg.type !== "city").map((s) => s.floor) : []);
  const nums = floorNums(c);
  return (
    <header className="plan-bar">
      {/* на телефоне полоса поверх плана сверху */}
      <div className="nav-col">
        <Seg value={campusId} onChange={setCampus} label="Кампус"
          items={Object.values(CAMPUSES).map((k) => ({ value: k.id, label: k.short }))} />
        <Seg value={floor} onChange={setFloor} label="Этаж" className={cx("floor-seg", nums.length > 4 && "many")}
          items={nums.map((n) => ({ value: n, title: `${n} этаж`, className: rtFloors.has(n) ? "has-route" : "", label: <>{n}<span className="fl-w"> этаж</span></> }))} />
      </div>
      <div className="spacer" />
      <SearchButton />
      <ThemeButton />
      <div className="floor-title">
        <div className="floor-n">Этаж {floor}</div>
        <Marquee className="floor-sum" text={autoSummary(c, floor)} />
      </div>
    </header>
  );
}

// Управление картой поверх плана: компас (поворот) и масштаб
function MapControls() {
  return (
    <div className="map-ctl">
      <Compass />
      <div className="zoom-ctl">
        <button id="zoomIn" title="Приблизить" onClick={() => planCtl.current?.zoomBy(1.4)}><Icon name="plus" /></button>
        <button id="zoomOut" title="Отдалить" onClick={() => planCtl.current?.zoomBy(1 / 1.4)}><Icon name="minus" /></button>
      </div>
    </div>
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
      <div className="tooltip" ref={tip} hidden />
      <MapControls />
      <TimeIsland />
      {!routeOpen && <RoomPeek />}
      {!routeOpen && <PlacePeek />}
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
