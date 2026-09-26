/* Переключатель: подложка переезжает под выбранную кнопку */
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { cx, reduceMotion } from "../lib/util";

export interface SegItem<T> { value: T; label: ReactNode; title?: string; className?: string }

interface Props<T> {
  items: SegItem<T>[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
  label?: string;
}

export function Seg<T extends string | number>({ items, value, onChange, className, label }: Props<T>) {
  const box = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLSpanElement>(null);
  const last = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  useLayoutEffect(() => {
    const seg = box.current!, th = thumb.current!;
    const place = (animate: boolean) => {
      const on = seg.querySelector<HTMLButtonElement>(":scope > button.on");
      if (!on || !on.offsetWidth) { th.style.opacity = "0"; last.current = null; return; } // переключатель скрыт
      const r = { x: on.offsetLeft, y: on.offsetTop, w: on.offsetWidth, h: on.offsetHeight };
      const p = last.current;
      if (p && p.x === r.x && p.y === r.y && p.w === r.w && p.h === r.h) return;
      th.style.transition = animate && p && !reduceMotion() ? "" : "none";
      th.style.borderRadius = getComputedStyle(on).borderRadius;
      th.style.opacity = "1";
      th.style.width = r.w + "px"; th.style.height = r.h + "px";
      th.style.transform = `translate(${r.x}px, ${r.y}px)`;
      last.current = r;
    };
    place(true);
    // размер меняется, когда догрузится шрифт или переключатель появится на экране
    const ro = new ResizeObserver(() => place(false));
    ro.observe(seg);
    return () => ro.disconnect();
  }, [value, items.length]);

  return (
    <div className={cx("seg", className)} ref={box} role="tablist" aria-label={label}>
      <span className="seg-thumb" ref={thumb} />
      {items.map((it) => (
        <button key={String(it.value)} className={cx(it.value === value && "on", it.className)} title={it.title}
          role="tab" aria-selected={it.value === value} onClick={() => onChange(it.value)}>
          {it.label}
        </button>
      ))}
    </div>
  );
}
