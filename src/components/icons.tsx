/* Иконки: внутренняя разметка SVG 24x24. Строки нужны и React-компонентам, и меткам на плане. */

const PATHS = {
  walk: '<circle cx="13" cy="4" r="2"/><path d="M13.5 8.5 11 14l-3 7M11 14l3.5 2.5.5 4.5M12.8 9 8.5 11l-1 3.5M13 9.5l2 3 3 1"/>',
  metro: '<path d="M3.5 18.5h17M6 18.5 9 6l3 7.5L15 6l3 12.5"/>',
  bus: '<rect x="4.5" y="3.5" width="15" height="14" rx="3"/><path d="M4.5 11h15M8 17.5v2.5M16 17.5v2.5"/><circle cx="8.5" cy="14.3" r=".6" fill="currentColor"/><circle cx="15.5" cy="14.3" r=".6" fill="currentColor"/>',
  street: '<circle cx="11" cy="4" r="2"/><path d="M11.5 8.5 9 14l-2.5 5.5M9 14l3.5 2.5.5 3M10.8 9 7 11l-.8 3M11 9.5l2 3 3 1"/><path d="M17 21v-5M17 16a2.5 3 0 1 0 0-.01"/>',
  scooter: '<circle cx="5.5" cy="18" r="2.5"/><circle cx="18.5" cy="18" r="2.5"/><path d="M8 18h8M16 18 13.5 5H11M13.5 5h3"/>',
  stairs: '<path d="M3 20h5v-5h5v-5h5V5h3"/>',
  lift: '<rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="m9 10 3-3 3 3M9 14l3 3 3-3"/>',
  pin: '<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.3"/>',
  route: '<circle cx="6" cy="18.5" r="2.5"/><circle cx="18" cy="5.5" r="2.5"/><path d="M8.5 18.5h7a3.5 3.5 0 0 0 0-7h-7a3.5 3.5 0 0 1 0-7H15.5"/>',
  swap: '<path d="M8 4v16M8 4 4.5 7.5M8 4l3.5 3.5M16 20V4M16 20l-3.5-3.5M16 20l3.5-3.5"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  next: '<path d="M9 5l7 7-7 7"/>',
  close: '<path d="M7 7l10 10M17 7 7 17"/>',
  sync: '<path d="M20 12a8 8 0 0 1-14.3 4.9M4 12a8 8 0 0 1 14.3-4.9"/><path d="M18.5 3v4.2h-4.2M5.5 21v-4.2h4.2"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="m16 10.5 5-3v9l-5-3"/>',
  cal: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="m9 15.5 2 2 4-4"/>',
  list: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4M7.5 14h3M7.5 17.5h6"/>',
  map: '<path d="M9 4 3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5Z"/><path d="M9 4v13.5M15 6.5V20"/>',
  // контур логотипа вуза тем же штрихом, что и остальные иконки меню
  door: '<path d="M4 21h16M6.5 21V4.5A1.5 1.5 0 0 1 8 3h8a1.5 1.5 0 0 1 1.5 1.5V21"/><circle cx="14.3" cy="12.3" r="1" fill="currentColor" stroke="none"/>',
  cu: '<path stroke-width="1.6" d="M8.14 10.21 3 13.79l6 3.35 11.93-6.36-3.43-1.98M8.14 10.21V3.5L15 7.36v6.57M8.14 10.21 15 13.93M11.54 18.5l3.46 2v-6.57"/>',
  rotL: '<path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v5h5"/>',
  rotR: '<path d="M20 12a8 8 0 1 1-2.4-5.7M20 4v5h-5"/>',
  minus: '<path d="M6 12h12"/>',
  plus: '<path d="M6 12h12M12 6v12"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5Z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5"/>',
  cap: '<path d="M2 9l10-5 10 5-10 5Z"/><path d="M6 11v5c3 2.5 9 2.5 12 0v-5"/><path d="M22 9v6"/>',
  screen: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5"/>',
  key: '<circle cx="8" cy="15" r="4.5"/><path d="m11.2 11.8 8.3-8.3M16.5 6.5l2.5 2.5M14 9l2 2"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 8.5V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.1 7.5 9.5 4.4-1.4 7.5-4.9 7.5-9.5V6Z"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  sched: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
} as const;

export type IconName = keyof typeof PATHS;
export const RT_IC: Record<"walk" | "stairs" | "lift", string> = {
  walk: `<svg viewBox="0 0 24 24">${PATHS.walk}</svg>`,
  stairs: `<svg viewBox="0 0 24 24">${PATHS.stairs}</svg>`,
  lift: `<svg viewBox="0 0 24 24">${PATHS.lift}</svg>`,
};

export const CITY_IC: Record<"metro" | "bus" | "street" | "scooter", string> = {
  metro: `<svg viewBox="0 0 24 24">${PATHS.metro}</svg>`,
  bus: `<svg viewBox="0 0 24 24">${PATHS.bus}</svg>`,
  street: `<svg viewBox="0 0 24 24">${PATHS.street}</svg>`,
  scooter: `<svg viewBox="0 0 24 24">${PATHS.scooter}</svg>`,
};

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return <svg viewBox="0 0 24 24" className={className} aria-hidden="true" dangerouslySetInnerHTML={{ __html: PATHS[name] }} />;
}
