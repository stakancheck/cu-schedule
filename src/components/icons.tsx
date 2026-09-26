/* Иконки: внутренняя разметка SVG 24x24. Строки нужны и React-компонентам, и меткам на плане. */

const PATHS = {
  walk: '<circle cx="13" cy="4" r="2"/><path d="M13.5 8.5 11 14l-3 7M11 14l3.5 2.5.5 4.5M12.8 9 8.5 11l-1 3.5M13 9.5l2 3 3 1"/>',
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
  star: '<path d="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4l-5.2 2.7 1-5.8L3.5 9.2l5.9-.9Z"/>',
  rotL: '<path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v5h5"/>',
  rotR: '<path d="M20 12a8 8 0 1 1-2.4-5.7M20 4v5h-5"/>',
  minus: '<path d="M6 12h12"/>',
  plus: '<path d="M6 12h12M12 6v12"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5Z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5"/>',
  cap: '<path d="M2 9l10-5 10 5-10 5Z"/><path d="M6 11v5c3 2.5 9 2.5 12 0v-5"/><path d="M22 9v6"/>',
  screen: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  sched: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
} as const;

export type IconName = keyof typeof PATHS;
export const RT_IC: Record<"walk" | "stairs" | "lift", string> = {
  walk: `<svg viewBox="0 0 24 24">${PATHS.walk}</svg>`,
  stairs: `<svg viewBox="0 0 24 24">${PATHS.stairs}</svg>`,
  lift: `<svg viewBox="0 0 24 24">${PATHS.lift}</svg>`,
};

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return <svg viewBox="0 0 24 24" className={className} aria-hidden="true" dangerouslySetInnerHTML={{ __html: PATHS[name] }} />;
}
