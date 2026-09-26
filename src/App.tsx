/* Каркас: план слева, колонка справа; на телефоне вкладки и полноэкранные экраны */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { getState, initialRoute, setState, useApp } from "./lib/store";
import {
  closeRoomScreen, goStep, openRoute, planCtl, routeBack, selectRoom, setDate, setFloor, setView, tick,
} from "./lib/actions";
import { account } from "./lib/account";
import { CAMPUSES } from "./lib/schedule";
import { initTelegram, setTgBackButton, syncTgColors } from "./lib/telegram";
import { addDays, cx, PHONE_MQ } from "./lib/util";
import { PlanPane } from "./components/PlanPane";
import { SideHead, useSwipeDays } from "./components/SideHead";
import { AllSchedule } from "./components/Events";
import { MineBar, MinePanel } from "./components/Mine";
import { RoomScreen } from "./components/Room";
import { RoutePanel } from "./components/Route";
import { TabBar, Toast, Useful } from "./components/Chrome";

const phoneMq = window.matchMedia(PHONE_MQ);
const usePhone = () => useSyncExternalStore(
  (cb) => { phoneMq.addEventListener("change", cb); return () => phoneMq.removeEventListener("change", cb); },
  () => phoneMq.matches,
);

// Системная «Назад» в Telegram и Esc: закрываем то, что открыто поверх
function back() {
  const s = getState();
  if (s.route.open) routeBack();
  else if (s.roomScreen) closeRoomScreen();
  else if (s.view !== "plan" && phoneMq.matches) setView("plan");
  else selectRoom(null);
}

function useKeys() {
  useEffect(() => {
    const floorKey = (k: string) => {
      const n = k === "0" ? 10 : +k;
      if (/^[0-9]$/.test(k) && CAMPUSES[getState().campus].floors[n]) { setFloor(n); return true; }
      return false;
    };
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT") { if (e.key === "Escape") t.blur(); return; }
      const s = getState();
      if (s.route.open) {
        if (e.key === "Escape") routeBack();
        else if (s.route.step >= 0 && e.key === "ArrowLeft") goStep(s.route.step - 1);
        else if (s.route.step >= 0 && e.key === "ArrowRight") goStep(s.route.step + 1);
        else floorKey(e.key);
        return;
      }
      if (e.key === "Escape") back();
      else if (e.key === "ArrowLeft") setDate(addDays(s.date, -1));
      else if (e.key === "ArrowRight") setDate(addDays(s.date, 1));
      else if (floorKey(e.key)) return;
      else if (e.key === "r" || e.key === "к") planCtl.current?.rotateTo(s.angle + 90);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}

export function App() {
  const view = useApp((s) => s.view), mine = useApp((s) => s.mine);
  const room = useApp((s) => s.room), roomScreen = useApp((s) => s.roomScreen);
  const routeOpen = useApp((s) => s.route.open), step = useApp((s) => s.route.step), picking = useApp((s) => s.route.picking);
  const phone = usePhone();
  const body = useRef<HTMLDivElement>(null), sched = useRef<HTMLDivElement>(null);

  // на телефоне расписание аудитории - отдельный экран, на компьютере - правая колонка
  const roomMode = phone ? roomScreen && !!room : !!room;
  const guiding = routeOpen && step >= 0, isPicking = routeOpen && !!picking;

  useKeys();
  useSwipeDays(body, () => {
    const s = getState();
    if (s.route.open) return null;
    const date = document.getElementById("dateRow");
    if (s.roomScreen && s.room) return [date, body.current?.querySelector<HTMLElement>(".room-screen") ?? null];
    return s.view === "list" ? [date, sched.current] : null;
  });

  useEffect(() => {
    initTelegram(back);
    syncTgColors();
    // Живое время
    const id = setInterval(tick, 20000);
    // вошли в календарь - показываем свои пары
    const off = account.onChange((why) => { if (why === "login") setState({ mine: true }); });
    // сразу показываем сохранённое, затем сверяемся с календарём
    if (account.user) account.sync();
    if (initialRoute) openRoute(initialRoute);
    return () => { clearInterval(id); off(); };
  }, []);

  useEffect(() => {
    setTgBackButton(!!room || (phone && view !== "plan") || routeOpen || roomScreen);
  }, [room, phone, view, routeOpen, roomScreen]);

  // новая вкладка или экран открываются сверху
  useEffect(() => { if (body.current) body.current.scrollTop = 0; }, [view, roomMode, routeOpen]);

  let content;
  if (routeOpen) content = <RoutePanel />;
  else if (roomMode) content = <RoomScreen />;
  else {
    content = (
      <>
        <div className="sched-part" ref={sched}>
          <MineBar />
          {mine && account.enabled ? <MinePanel /> : <AllSchedule />}
        </div>
        <Useful />
      </>
    );
  }

  return (
    <div className={cx("app", routeOpen && "routing", guiding && "guiding", isPicking && "picking", phone && roomMode && "room-mode")} id="app" data-view={view}>
      <PlanPane />
      <aside className="side">
        <SideHead />
        <div className="side-body" id="sideBody" ref={body}>{content}</div>
      </aside>
      <Toast />
      <TabBar />
    </div>
  );
}
