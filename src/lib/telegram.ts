/* Telegram Mini App: вне Telegram скрипт тоже грузится, но platform = "unknown" */
import { PHONE_MQ } from "./util";

export const tg = window.Telegram?.WebApp;
export const inTg = !!(tg && tg.platform && tg.platform !== "unknown");
export const tgAt = (v: string) => inTg && !!tg && tg.isVersionAtLeast(v);

export const haptic = {
  select() { if (tgAt("6.1")) tg!.HapticFeedback.selectionChanged(); },
  ok() { if (tgAt("6.1")) tg!.HapticFeedback.notificationOccurred("success"); },
  error() { if (tgAt("6.1")) tg!.HapticFeedback.notificationOccurred("error"); },
};

export function syncTgColors() {
  if (!tgAt("6.1")) return;
  // на телефоне фон экрана - цвет панели (без карточек-островков)
  const phone = window.matchMedia(PHONE_MQ).matches;
  const bg = getComputedStyle(document.documentElement).getPropertyValue(phone ? "--panel" : "--bg").trim();
  if (!/^#[0-9a-f]{6}$/i.test(bg)) return;
  tg!.setHeaderColor(bg);
  tg!.setBackgroundColor(bg);
  if (tgAt("7.10")) tg!.setBottomBarColor(bg);
}

export function initTelegram(onBack: () => void) {
  if (!inTg || !tg) return;
  document.documentElement.classList.add("tma");
  // Всегда на всю высоту (fullsize). Часть клиентов игнорирует expand(),
  // пока окно не показано, поэтому повторяем, пока Telegram не подтвердит.
  const expand = () => { if (!tg.isExpanded) tg.expand(); };
  tg.expand();
  tg.ready();
  [150, 500, 1200].forEach((ms) => setTimeout(expand, ms));
  tg.onEvent("viewportChanged", (e) => { if (!e || e.isStateStable) expand(); });
  if (tgAt("8.0")) tg.onEvent("activated", expand);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) expand(); });
  // иначе перетаскивание плана вниз сворачивает мини-апп
  if (tgAt("7.7")) tg.disableVerticalSwipes();
  if (tgAt("6.1")) {
    tg.BackButton.onClick(onBack);
    // «Назад» есть в шапке Telegram: свои кнопки возврата прячем
    document.documentElement.classList.add("tg-back");
  }
  // внешние ссылки открываем через Telegram, а не внутри мини-аппа
  document.addEventListener("click", (e) => {
    const a = (e.target as Element).closest?.('a[target="_blank"]') as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault();
    // ссылки на Telegram открываем нативно, остальные во внешнем браузере
    if (/^https:\/\/t\.me\//.test(a.href)) tg.openTelegramLink(a.href);
    else tg.openLink(a.href);
  });
}

export function setTgBackButton(visible: boolean) {
  if (!tgAt("6.1")) return;
  if (visible) tg!.BackButton.show(); else tg!.BackButton.hide();
}
