/* План этажа: векторы из PDF в SVG, поворот, масштаб, жесты, подсказка и слой маршрута.
 * Это не React: тысячи путей и анимация камеры идут напрямую в DOM,
 * а состояние берём из стора по подписке. */
import type { Campus, Floor, PlanRoom, StreetText } from "../types";
import { CAMPUSES, centroid, roomFloor, roomStatus } from "../lib/schedule";
import { getState, setState, subscribe, type AppState } from "../lib/store";
import { planCtl, pickPoint, selectPlace, selectRoom, tapPlaceInRoute, type Box, type FocusOpts } from "../lib/actions";
import { fmt, isPhone, reduceMotion } from "../lib/util";
import { debugImage, links } from "../nav/engine";
import { getPlace, iconPlace, labelPlace } from "../nav/places";
import { CATS, placeInfo } from "../nav/info";
import { NAV } from "../nav/data";
import { CITY_IC, RT_IC } from "../components/icons";
import { ADDRESS } from "../nav/city";

const SVGNS = "http://www.w3.org/2000/svg";
export const NAV_DEBUG = /[?&]navdebug\b/.test(location.search);

type Attrs = Record<string, string | number>;
function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs, parent?: Element | null): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  if (parent) parent.appendChild(e);
  return e;
}
const ptsAttr = (pts: [number, number][]) => pts.map((p) => p.join(",")).join(" ");
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

const TAG_CLS: Record<string, string> = { kitchen: "tag-kitchen", staff: "tag-staff", fitness: "tag-fitness", closed: "tag-closed", health: "tag-health", wip: "tag-wip" };
const ROOM_FILL: Record<string, string> = { kitchen: "kitchen", staff: "staff", fitness: "fitness", closed: "closed", health: "health" };
const isCowork = (r: { label?: string; text?: string }) => /Коворкинг|Опенспейс/.test(r.label || r.text || "") && !/сотрудник/.test(r.label || r.text || "");
const short = (t: string, n = 26) => (t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t);

const angleOf = (a: [number, number], b: [number, number]) => (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

// Листы PDF с этажами сдвинуты друг относительно друга (у Дуката до сотни единиц).
// Сдвиг этажа до общей системы считаем по лестницам и лифтам: у них на каждом
// этаже одна и та же точка здания. Этажи без общей связи с остальными не сдвигаем.
const shiftCache: Record<string, Record<number, [number, number]>> = {};
function floorShift(campus: Campus, n: number): [number, number] {
  let sh = shiftCache[campus.id];
  if (!sh) {
    const nav = NAV[campus.id]?.links || [];
    const nums = Object.keys(campus.floors).map(Number).sort((a, b) => a - b);
    sh = shiftCache[campus.id] = { [nums[0]]: [0, 0] };
    // обход в ширину от нижнего этажа: сдвиг соседа = свой + среднее расхождение общих связей
    for (let queue = [nums[0]]; queue.length; ) {
      const a = queue.shift()!;
      const d: Record<number, [number, number, number]> = {};
      for (const l of nav) {
        const pa = l.at[a];
        if (!pa) continue;
        for (const k in l.at) {
          const b = Number(k);
          if (b === a || sh[b]) continue;
          const v = (d[b] ||= [0, 0, 0]);
          v[0] += pa[0] - l.at[b][0]; v[1] += pa[1] - l.at[b][1]; v[2]++;
        }
      }
      for (const k in d) {
        const [x, y, c] = d[k];
        sh[k] = [sh[a][0] + x / c, sh[a][1] + y / c];
        queue.push(Number(k));
      }
    }
  }
  return sh[n] || [0, 0];
}

interface Upright { g: SVGGElement; x: number; y: number }
interface Rotating extends Upright { angle: number }

export class PlanRenderer {
  private world!: SVGGElement;
  private labels: Upright[] = [];
  private streetLabels: Rotating[] = [];
  private roomEls: Record<string, SVGPolygonElement> = {};
  private roomLabelEls: Record<string, { sub: SVGTextElement; dot: SVGCircleElement }> = {};
  private placeEls = new Map<string, Element[]>(); // места без расписания: заливка, подписи, иконки
  private selG: SVGGElement | null = null;
  private selMarks: Upright[] = [];
  private routeG: SVGGElement | null = null;
  private routeTop: SVGGElement | null = null;
  private routeMarks: Upright[] = [];
  private campus: Campus;
  private CX = 0; private CY = 0;
  private viewAngle: number;
  private zoom = 1;
  private pan: [number, number] = [0, 0];
  private focusAnim = 0;
  private inset = 0; // пикселей снизу под панелью: вид вписывается в то, что над ней
  private insetAnim = 0;
  private drag: {
    x: number; y: number; moved: boolean; target: Element | null;
    pinch?: number; ang?: number; twist?: number; turning?: boolean; lag?: number; // два пальца: расстояние, угол, накопленный поворот, отставание плана от пальцев
    spin?: number;                                                    // Shift + мышь: угол указателя вокруг центра
  } | null = null;
  private pointers = new Map<number, [number, number]>();
  private unsub: () => void;
  private off: (() => void)[] = [];

  constructor(private svg: SVGSVGElement, private wrap: HTMLElement, private tip: HTMLElement) {
    const s = getState();
    this.campus = CAMPUSES[s.campus];
    this.viewAngle = s.angle;
    this.updateCenter();
    this.build();
    this.bindGestures();
    this.unsub = subscribe((s, prev) => this.onState(s, prev));
    planCtl.current = {
      focusRoom: (id) => this.focusRoom(id),
      focusBox: (b, o) => this.focusBox(b, o),
      rotateTo: (a) => this.rotateTo(a),
      turn: (a) => this.turnAround(a),
      settle: () => this.settle(),
      zoomBy: (k) => this.zoomAt(k),
      setInset: (px) => this.setInset(px),
    };
    const onResize = () => this.applyTransform();
    window.addEventListener("resize", onResize);
    this.off.push(() => window.removeEventListener("resize", onResize));
    // размер области плана меняется при переключении экранов на телефоне
    const ro = new ResizeObserver(onResize);
    ro.observe(svg);
    this.off.push(() => ro.disconnect());
  }

  destroy() {
    this.unsub();
    this.off.forEach((f) => f());
    planCtl.current = null;
  }

  private onState(s: AppState, prev: AppState) {
    if (s.campus !== prev.campus || s.floor !== prev.floor) {
      if (s.campus !== prev.campus) {
        this.campus = CAMPUSES[s.campus]; this.updateCenter();
        this.zoom = 1; this.pan = [0, 0];
      } else {
        // тот же кампус: масштаб прежний, в центре экрана то же место здания
        this.focusAnim++;
        const [ax, ay] = floorShift(this.campus, prev.floor), [bx, by] = floorShift(this.campus, s.floor);
        const r = (this.viewAngle * Math.PI) / 180, dx = ax - bx, dy = ay - by;
        this.pan[0] += dx * Math.cos(r) - dy * Math.sin(r);
        this.pan[1] += dx * Math.sin(r) + dy * Math.cos(r);
      }
      this.build();
      return;
    }
    if (s.date !== prev.date || s.t !== prev.t || s.room !== prev.room) this.paintRooms();
    if (s.place !== prev.place) this.paintPlace();
    if (s.route !== prev.route) this.paintRoute();
  }

  /* ---------- построение этажа */
  private upright(parent: Element, x: number, y: number) {
    const g = el("g", {}, parent);
    this.labels.push({ g, x, y });
    return g;
  }

  private tag(parent: Element, text: string, { size = 14, cls = "", padX = 8 } = {}) {
    const g = el("g", { class: cls }, parent);
    const w = text.length * size * 0.58 + padX * 2, hh = size * 1.9;
    el("rect", { class: "tagbox", x: -w / 2, y: -hh / 2, width: w, height: hh, rx: 3 }, g);
    el("text", { class: "tagtxt", "font-size": size }, g).textContent = text;
    return g;
  }

  // Серые подписи: вдоль улицы или стрелки (при повороте плана не встают
  // вверх ногами) либо блоком строк, который всегда стоит вертикально
  private streetText(parent: Element, s: StreetText) {
    if (s.lines) {
      const g = this.upright(parent, s.x, s.y);
      for (const l of s.lines) {
        const t = el("text", { class: "street-lbl", x: l.dx, y: l.dy }, g);
        t.style.fontSize = s.size + "px";
        t.style.textAnchor = "start";
        t.textContent = l.text;
      }
      return;
    }
    const g = el("g", {}, parent);
    const t = el("text", { class: "street-lbl" }, g);
    t.style.fontSize = s.size + "px";
    t.textContent = s.text || "";
    this.streetLabels.push({ g, x: s.x, y: s.y, angle: s.angle || 0 });
  }

  private build() {
    const s = getState();
    const floor = this.campus.floors[s.floor];
    this.svg.innerHTML = "";
    this.labels = []; this.streetLabels = []; this.roomEls = {}; this.roomLabelEls = {}; this.placeEls.clear();
    this.world = el("g", {}, this.svg);
    this.buildFloor(floor);
    this.applyTransform();
    this.paintRooms();
    this.paintPlace();
    this.paintRoute();
  }

  // Элемент плана открывает место: помечаем его и запоминаем для подсветки
  private asPlace<E extends Element>(e: E, key: string | undefined) {
    if (!key) return e;
    e.setAttribute("data-place", key);
    e.classList.add("hit");
    const list = this.placeEls.get(key);
    if (list) list.push(e); else this.placeEls.set(key, [e]);
    return e;
  }

  private buildFloor(floor: Floor) {
    const fg = el("g", {}, this.world);
    const eo = (p: { eo: boolean }) => (p.eo ? "evenodd" : "nonzero");
    const c = this.campus;
    if (c.streets) {
      for (const p of c.streets.paths) el("path", { class: "v-street", d: p.d, "fill-rule": eo(p) }, fg);
      for (const t of c.streets.texts) this.streetText(fg, t);
    }
    for (const p of floor.floorPaths) el("path", { class: "v-floor", d: p.d, "fill-rule": eo(p) }, fg);

    const roomsG = el("g", { class: "rooms" }, fg);
    for (const r of floor.rooms) {
      if (!r.pts.length || roomFloor[r.id]) continue;
      const k = ROOM_FILL[r.color] || (isCowork(r) ? "open" : "plain");
      this.asPlace(el("polygon", { class: "r v " + k, points: ptsAttr(r.pts) }, roomsG), getPlace("r:" + r.id)?.key);
    }
    for (const p of floor.wallPaths) el("path", { class: "v-wall", d: p.d, "fill-rule": eo(p) }, fg);
    for (const p of floor.voidPaths) el("path", { class: "v-void", d: p.d, "fill-rule": eo(p) }, fg);

    const classG = el("g", { class: "rooms" }, fg);
    for (const r of floor.rooms) {
      if (!roomFloor[r.id]) continue;
      this.roomEls[r.id] = el("polygon", { class: "r v class", points: ptsAttr(r.pts), "data-room": r.id }, classG);
    }

    if (NAV_DEBUG) {
      const im = debugImage(c.id, floor.n);
      el("image", { href: im.href, x: im.x, y: im.y, width: im.w, height: im.h, preserveAspectRatio: "none", style: "image-rendering:pixelated;pointer-events:none" }, fg);
    }
    this.routeG = el("g", { class: "route" }, fg);

    for (const p of floor.decorPaths || []) el("path", { class: "v-street", d: p.d, "fill-rule": eo(p) }, fg);
    for (const t of floor.decorTexts || []) this.streetText(fg, t);

    for (const ic of floor.icons) {
      const g = this.upright(fg, ic.x, ic.y);
      g.setAttribute("class", "vicon");
      for (const p of ic.parts) el("path", { class: "ic-" + p.c, d: p.d, "fill-rule": eo(p) }, g);
      // туалет, лестница, лифт, значок кухни: круг чуть больше иконки, чтобы попасть пальцем
      const pl = iconPlace(c.id, floor.n, ic.x, ic.y, ic.parts.some((p) => p.c === "kitchen"));
      if (pl) { el("circle", { class: "ic-hit", r: 17 }, g); this.asPlace(g, pl.key); }
    }

    floor.labels.forEach((l, i) => {
      // вертикальная плашка поворачивается вместе с планом, как подпись улицы
      const g = l.vertical ? el("g", {}, fg) : this.upright(fg, l.x, l.y);
      if (l.vertical) this.streetLabels.push({ g, x: l.x, y: l.y, angle: -90 });
      const cls = isCowork(l) ? "tag-open" : TAG_CLS[l.color] || "";
      const t = this.tag(g, l.text, { size: l.big ? 30 : 12, cls, padX: l.big ? 14 : 7 });
      const pl = labelPlace(c.id, floor.n, i);
      if (pl) this.asPlace(t, pl.key); else t.style.pointerEvents = "none";
    });

    for (const r of floor.rooms) {
      if (roomFloor[r.id]) this.roomLabel(fg, r);
      else {
        const g = this.upright(fg, r.tag[0], r.tag[1]);
        const text = r.label ? `${short(r.label)} · ${r.id}` : r.id;
        const tagEl = this.tag(g, text, { size: 11, cls: isCowork(r) ? "tag-open" : TAG_CLS[r.color] || "", padX: 6 });
        this.asPlace(tagEl, getPlace("r:" + r.id)?.key);
      }
    }
    this.selG = el("g", { class: "place-sel" }, fg);
    this.routeTop = el("g", { class: "route-top" }, fg);
    if (NAV_DEBUG) this.debugStops(fg, floor.n);
  }

  private roomLabel(parent: Element, r: PlanRoom) {
    const [cx, cy] = centroid(r.pts);
    const g = this.upright(parent, cx, cy);
    g.setAttribute("class", "room-lbl");
    const w = r.id.length * 10.6 + 24;
    el("rect", { class: "tagbox", x: -w / 2, y: -14, width: w, height: 26, rx: 4 }, g);
    const dot = el("circle", { class: "dot", cx: -w / 2 + 9, cy: -1, r: 4 }, g);
    el("text", { class: "tagtxt code", x: 5, y: -1 }, g).textContent = r.id;
    const sub = el("text", { class: "sub", y: 27, "text-anchor": "middle" }, g);
    this.roomLabelEls[r.id] = { sub, dot };
  }

  private paintRooms() {
    const s = getState();
    for (const [room, poly] of Object.entries(this.roomEls)) {
      const st = roomStatus(room, s.date, s.t);
      poly.classList.remove("free", "soon", "busy");
      poly.classList.add(st.st);
      poly.classList.toggle("sel", room === s.room);
      const lab = this.roomLabelEls[room];
      lab.dot.setAttribute("class", "dot dot-" + st.st);
      lab.sub.setAttribute("class", "sub dot-" + st.st);
      lab.sub.textContent = st.st === "busy" ? `до ${fmt(st.until!)}` : st.until ? `своб. до ${fmt(st.until)}` : "свободна";
    }
    this.svg.querySelectorAll(".rooms").forEach((g) => g.classList.toggle("has-sel", !!s.room));
  }

  // Выбранное место: подсветка его заливки и подписей, булавка в его точке
  private paintPlace() {
    if (!this.selG) return;
    this.svg.querySelectorAll(".hit.sel").forEach((e) => e.classList.remove("sel"));
    this.selG.textContent = "";
    this.selMarks = [];
    const s = getState(), p = getPlace(s.place);
    if (!p || p.campus !== s.campus || p.floor !== s.floor) return;
    for (const e of this.placeEls.get(p.key) || []) e.classList.add("sel");
    const g = el("g", { class: "pl-pin tone-" + CATS[placeInfo(p).cat].tone }, this.selG);
    el("path", { d: "M0,0C-3,-6 -11,-11 -11,-20A11,11 0 1 1 11,-20C11,-11 3,-6 0,0Z" }, g);
    el("circle", { cy: -20, r: 4.2 }, g);
    this.selMarks.push({ g, x: p.x!, y: p.y! });
    this.applyTransform();
  }

  /* ---------- линия и метки маршрута */
  private paintRoute() {
    if (!this.routeG || !this.routeTop) return;
    this.routeG.textContent = "";
    this.routeTop.textContent = "";
    this.routeMarks = [];
    const s = getState(), r = s.route;
    const o = r.open && r.options ? r.options[r.sel] : null;
    if (!o) return;
    // в маршруте между кампусами у отрезков свой кампус, рисуем только отрезки этого плана
    const here = (l: { campus?: string }) => (l.campus || r.campus) === s.campus;
    if (!o.legs.some((l) => (l.type === "city" ? l.from === s.campus || l.to === s.campus : here(l)))) return;
    const cur = r.step >= 0 ? o.steps[r.step] : null;
    const top = this.routeTop;
    const mark = (x: number, y: number, cls: string) => {
      const g = el("g", { class: "rt-mark " + cls }, top);
      this.routeMarks.push({ g, x, y });
      return g;
    };
    for (const leg of o.legs) {
      if (leg.type !== "walk" || !here(leg) || leg.floor !== s.floor || leg.pts.length < 2) continue;
      const d = "M" + leg.pts.map((p) => p.map((v) => v.toFixed(1)).join(",")).join("L");
      const dim = !!cur && cur.leg !== leg;
      const g = el("g", { class: "rt-leg" + (dim ? " dim" : "") }, this.routeG);
      el("path", { class: "rt-case", d }, g);
      el("path", { class: "rt-line", d }, g);
      if (!dim) el("path", { class: "rt-flow", d }, g);
    }
    // старт: начало первого пешего отрезка
    const first = o.legs[0];
    const start = getPlace(r.from);
    if (start && start.campus === s.campus && start.floor === s.floor && first.type !== "city") {
      const [x, y] = first.type === "walk" && first.pts.length ? first.pts[0] : [start.x!, start.y!];
      el("circle", { r: 7 }, mark(x, y, "rt-start"));
    }
    const last = o.legs[o.legs.length - 1];
    if (last.type === "walk" && here(last) && last.floor === s.floor) {
      const [x, y] = last.pts[last.pts.length - 1];
      const g = mark(x, y, "rt-goal");
      el("path", { d: "M0,0C-3,-6 -11,-11 -11,-20A11,11 0 1 1 11,-20C11,-11 3,-6 0,0Z" }, g);
      el("circle", { cy: -20, r: 4.2 }, g);
    }
    // выход на улицу и вход с улицы в маршруте между кампусами
    const city = o.legs.findIndex((l) => l.type === "city");
    if (city >= 0) {
      const c = o.legs[city] as Extract<(typeof o.legs)[number], { type: "city" }>;
      const on = !!cur && cur.leg === c;
      const ends: [string, typeof o.legs[number] | undefined, "end" | "start", string][] = [
        [c.from, o.legs[city - 1], "end", "→ " + CAMPUSES[c.to].short],
        [c.to, o.legs[city + 1], "start", "из " + CAMPUSES[c.from].short],
      ];
      for (const [cid, leg, side, txt] of ends) {
        if (cid !== s.campus) continue;
        let p: [number, number] | null = null, n = 0;
        if (leg && leg.type === "walk") { p = side === "end" ? leg.pts[leg.pts.length - 1] : leg.pts[0]; n = leg.floor; }
        else {
          const e = getPlace(ADDRESS[cid].entrance);
          if (e) { p = [e.x!, e.y!]; n = e.floor!; }
        }
        if (!p || n !== s.floor) continue;
        this.pill(mark(p[0], p[1], "rt-ride" + (on ? " on" : "")), txt, CITY_IC[c.mode]);
      }
    }
    // переходы: на этаже отправления «↑ 3 этаж», на этаже прибытия «с 1 этажа»
    for (const leg of o.legs) {
      if (leg.type !== "ride" || !here(leg)) continue;
      const on = !!cur && cur.leg === leg;
      const ends: [number, [number, number], string][] = [
        [leg.from, leg.fromAt, (leg.to > leg.from ? "↑ " : "↓ ") + leg.to + " этаж"],
        [leg.to, leg.at, "с " + leg.from + " этажа"],
      ];
      for (const [n, p, txt] of ends) {
        if (n !== s.floor) continue;
        this.pill(mark(p[0], p[1], "rt-ride" + (on ? " on" : "")), txt, RT_IC[leg.kind]);
      }
    }
    this.applyTransform();
  }

  // Подпись-пилюля над точкой: иконка и текст
  private pill(g: SVGGElement, txt: string, icon: string) {
    const w = txt.length * 6.6 + 34;
    el("rect", { x: -w / 2, y: -30, width: w, height: 22, rx: 11 }, g);
    const ic = el("g", { transform: `translate(${-w / 2 + 6},-27) scale(.66)`, class: "rt-ride-ic" }, g);
    ic.innerHTML = icon.replace(/^<svg[^>]*>|<\/svg>$/g, "");
    el("text", { x: -w / 2 + 25, y: -19 }, g).textContent = txt;
    el("circle", { r: 4.5 }, g);
  }

  /* ---------- поворот и масштаб */
  private updateCenter() {
    const xs = this.campus.extent.map((p) => p[0]), ys = this.campus.extent.map((p) => p[1]);
    this.CX = (Math.min(...xs) + Math.max(...xs)) / 2;
    this.CY = (Math.min(...ys) + Math.max(...ys)) / 2;
  }

  private rotated(a: number) {
    const rad = (a * Math.PI) / 180, c = Math.cos(rad), s = Math.sin(rad);
    const { CX, CY } = this;
    return (x: number, y: number): [number, number] => [CX + (x - CX) * c - (y - CY) * s, CY + (x - CX) * s + (y - CY) * c];
  }

  private applyTransform() {
    const a = this.viewAngle, { CX, CY } = this;
    this.world.setAttribute("transform", `rotate(${a} ${CX} ${CY})`);
    for (const l of this.labels) l.g.setAttribute("transform", `translate(${l.x},${l.y}) rotate(${-a})`);
    for (const s of this.streetLabels) {
      let v = ((s.angle + a) % 360 + 360) % 360;
      if (v >= 90 && v < 270) v -= 180; // вертикальные читаются снизу вверх, как в PDF
      s.g.setAttribute("transform", `translate(${s.x},${s.y}) rotate(${v - a})`);
    }
    // рамка по повернутому extent
    // вид ровно по размеру экрана: план вписан в часть над нижней панелью и сдвинут вверх на половину её высоты
    const box = this.svg.getBoundingClientRect();
    const W = box.width || 800, H = box.height || 600;
    const u = this.baseUpp(a) / this.zoom; // единиц плана в пикселе
    const w = W * u, h = H * u;
    const cx = CX + this.pan[0], cy = CY + this.pan[1] + (this.visibleInset(H) * u) / 2;
    this.svg.setAttribute("viewBox", `${cx - w / 2} ${cy - h / 2} ${w} ${h}`);
    // метки маршрута одного размера на экране при любом масштабе
    this.svg.style.setProperty("--u", u.toFixed(3) + "px");
    for (const l of [...this.routeMarks, ...this.selMarks]) l.g.setAttribute("transform", `translate(${l.x},${l.y}) rotate(${-a}) scale(${u.toFixed(3)})`);
    document.getElementById("dial")?.setAttribute("transform", `rotate(${a})`);
    document.getElementById("compassN")?.setAttribute("transform", `translate(0,-12) rotate(${-a})`);
    const off = Math.abs(a - Math.round(a / 360) * 360);
    this.svg.closest(".plan-pane")?.classList.toggle("turned", off > 0.5);
  }

  // Единиц плана в пикселе при zoom = 1: вписанная рамка зависит от угла
  private baseUpp(a: number) {
    const rot = this.rotated(a);
    const rp = this.campus.extent.map(([x, y]) => rot(x, y));
    const bw = Math.max(...rp.map((p) => p[0])) - Math.min(...rp.map((p) => p[0]));
    const bh = Math.max(...rp.map((p) => p[1])) - Math.min(...rp.map((p) => p[1]));
    const box = this.svg.getBoundingClientRect(), H = box.height || 600;
    return Math.max(bw / (box.width || 800), bh / (H - this.visibleInset(H)));
  }

  // Панель не должна съедать больше половины плана, иначе он станет совсем мелким
  private visibleInset(H: number) { return Math.min(this.inset, H * 0.5); }

  // Нижняя панель открылась или закрылась: план плавно переезжает в видимую часть
  setInset(px: number) {
    px = Math.max(0, Math.round(px));
    const from = this.inset, t0 = performance.now(), dur = reduceMotion() ? 0 : 280, id = ++this.insetAnim;
    if (from === px) return;
    const step = (now: number) => {
      if (id !== this.insetAnim) return;
      const k = dur ? Math.min(1, (now - t0) / dur) : 1;
      this.inset = from + (px - from) * (1 - Math.pow(1 - k, 3));
      this.applyTransform();
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // Поворот рукой: точка под пальцем (по умолчанию центр экрана) остаётся на месте, масштаб не прыгает
  private turnAround(a: number, clientX?: number, clientY?: number) {
    this.focusAnim++;
    if (clientX == null) { const b = this.svg.getBoundingClientRect(); clientX = b.left + b.width / 2; clientY = b.top + b.height / 2; }
    const p = this.worldPoint(clientX, clientY!);
    this.zoom = Math.min(6, Math.max(0.5, (this.zoom * this.baseUpp(a)) / this.baseUpp(this.viewAngle)));
    this.viewAngle = a;
    this.applyTransform();
    const sp = this.svgPoint(clientX, clientY!), [rx, ry] = this.rotated(a)(p.x, p.y);
    this.pan[0] += rx - sp.x;
    this.pan[1] += ry - sp.y;
    this.applyTransform();
  }

  // Конец поворота рукой: рядом с прямым углом доводим до него, угол сохраняем
  private settle() {
    const from = this.viewAngle, to = Math.round(from / 90) * 90;
    if (Math.abs(to - from) > 7 || to === from) { setState({ angle: from }); return; }
    setState({ angle: to });
    const t0 = performance.now(), dur = reduceMotion() ? 0 : 220;
    const step = (now: number) => {
      const k = dur ? Math.min(1, (now - t0) / dur) : 1;
      this.turnAround(from + (to - from) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  rotateTo(target: number) {
    const from = this.viewAngle, t0 = performance.now(), dur = 380;
    setState({ angle: target });
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      this.viewAngle = from + (target - from) * e;
      this.applyTransform();
      if (k < 1) requestAnimationFrame(step);
      else { this.viewAngle = target; this.applyTransform(); }
    };
    requestAnimationFrame(step);
  }

  private svgPoint(clientX: number, clientY: number) {
    const p = this.svg.createSVGPoint();
    p.x = clientX; p.y = clientY;
    return p.matrixTransform(this.svg.getScreenCTM()!.inverse());
  }

  // Точка плана (без поворота) под пальцем
  private worldPoint(clientX: number, clientY: number) {
    const p = this.svg.createSVGPoint();
    p.x = clientX; p.y = clientY;
    return p.matrixTransform(this.world.getScreenCTM()!.inverse());
  }

  zoomAt(factor: number, clientX?: number, clientY?: number) {
    this.focusAnim++; // ручной масштаб отменяет наведение на аудиторию
    const before = clientX != null ? this.svgPoint(clientX, clientY!) : null;
    this.zoom = Math.min(6, Math.max(Math.min(1, this.zoom), this.zoom * factor)); // после поворота рукой бывает меньше 1
    if (this.zoom === 1) this.pan = [0, 0];
    this.applyTransform();
    if (before && this.zoom > 1) {
      const after = this.svgPoint(clientX!, clientY!);
      this.pan[0] += before.x - after.x;
      this.pan[1] += before.y - after.y;
      this.applyTransform();
    }
  }

  focusRoom(room: string) {
    const r = this.campus.floors[getState().floor]?.rooms.find((x) => x.id === room);
    if (!r || !r.pts.length) return;
    const xs = r.pts.map((p) => p[0]), ys = r.pts.map((p) => p[1]);
    this.focusBox({ x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) });
  }

  // Плавно показать область плана. fill - какую долю экрана она займёт,
  // bottom - сколько пикселей снизу закрыто карточкой (область поднимается над ней).
  focusBox(b: Box, { fill = 0.25, minZoom = 1.6, maxZoom = 4.5, bottom = null, square = true }: FocusOpts = {}) {
    const rot = this.rotated(getState().angle), { CX, CY } = this;
    const [rx, ry] = rot(b.x + b.width / 2, b.y + b.height / 2);
    // размер вида при zoom = 1 (как в applyTransform)
    const rp = this.campus.extent.map(([px, py]) => rot(px, py));
    const bw = Math.max(...rp.map((p) => p[0])) - Math.min(...rp.map((p) => p[0]));
    const bh = Math.max(...rp.map((p) => p[1])) - Math.min(...rp.map((p) => p[1]));
    // при preserveAspectRatio=meet в пикселях видно min(W/bw, H/bh) * zoom
    const box = this.svg.getBoundingClientRect();
    const W = box.width || 800, H = box.height || 600;
    const fit = Math.min(W / bw, H / bh);
    const cover = bottom ?? (isPhone() ? H * 0.2 : 0);
    const Hv = H - cover; // видимая часть над карточкой
    // square: область как квадрат по меньшей стороне экрана (аудитория), иначе вписываем прямоугольник
    const bw2 = Math.max(b.width, 1) * fit, bh2 = Math.max(b.height, 1) * fit;
    const want = square ? (fill * Math.min(W, Hv)) / Math.max(bw2, bh2) : Math.min((fill * W) / bw2, (fill * Hv) / bh2);
    const zoom = Math.min(maxZoom, Math.max(minZoom, want));
    // центр области - в центр видимой части: поднимаем над карточкой снизу
    const lift = cover / 2 / (fit * zoom);
    const target = { zoom, pan: [rx - CX, ry - CY + lift] as [number, number] };

    const from = { zoom: this.zoom, pan: [...this.pan] as [number, number] };
    const t0 = performance.now(), dur = reduceMotion() ? 0 : 520, id = ++this.focusAnim;
    const step = (now: number) => {
      if (id !== this.focusAnim) return; // началась новая анимация
      const k = dur ? Math.min(1, (now - t0) / dur) : 1;
      const e = 1 - Math.pow(1 - k, 3);
      this.zoom = from.zoom + (target.zoom - from.zoom) * e;
      this.pan = [from.pan[0] + (target.pan[0] - from.pan[0]) * e, from.pan[1] + (target.pan[1] - from.pan[1]) * e];
      this.applyTransform();
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ---------- жесты: перетаскивание, щипок, колесо, нажатие */
  private bindGestures() {
    const { svg } = this;
    const on = <K extends keyof SVGElementEventMap>(type: K, fn: (e: SVGElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      svg.addEventListener(type, fn as EventListener, opts);
      this.off.push(() => svg.removeEventListener(type, fn as EventListener));
    };
    on("wheel", (e) => { e.preventDefault(); this.zoomAt(Math.exp(-e.deltaY * 0.0022), e.clientX, e.clientY); }, { passive: false });

    on("pointerdown", (e) => {
      this.focusAnim++;
      if (e.pointerType !== "mouse") this.hideTip();
      this.pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.drag = { x: 0, y: 0, pinch: Math.hypot(a[0] - b[0], a[1] - b[1]), ang: angleOf(a, b), twist: 0, moved: true, target: null };
        return;
      }
      this.drag = { x: e.clientX, y: e.clientY, moved: false, target: e.target as Element };
      if (e.pointerType === "mouse" && e.shiftKey) this.drag.spin = this.centerAngle(e.clientX, e.clientY);
    });
    on("pointermove", (e) => {
      this.moveTip(e);
      const d = this.drag;
      if (!d) return;
      this.pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (d.pinch && this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        this.zoomAt(dist / d.pinch, mx, my);
        d.pinch = dist;
        // поворот включается, только когда пальцы заметно провернули: обычный щипок план не крутит.
        // Набранный до порога угол не прикладываем рывком, а догоняем за несколько движений
        const ang = angleOf(a, b);
        let da = wrap180(ang - d.ang!);
        d.ang = ang;
        if (!d.turning) {
          d.twist! += da;
          if (Math.abs(d.twist!) < 7) return;
          d.turning = true;
          d.lag = d.twist!;
          da = 0;
        }
        const catchUp = d.lag! * 0.25;
        d.lag! -= catchUp;
        this.turnAround(this.viewAngle + da + catchUp, mx, my);
        return;
      }
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 5) return;
      if (!d.moved) { d.moved = true; svg.setPointerCapture(e.pointerId); svg.classList.add("dragging"); this.hideTip(); }
      if (d.spin != null) {
        const ang = this.centerAngle(e.clientX, e.clientY);
        this.turnAround(this.viewAngle + wrap180(ang - d.spin));
        d.spin = ang;
      } else if (this.zoom > 1) {
        const p0 = this.svgPoint(d.x, d.y), p1 = this.svgPoint(e.clientX, e.clientY);
        this.pan[0] -= p1.x - p0.x;
        this.pan[1] -= p1.y - p0.y;
        this.applyTransform();
      }
      d.x = e.clientX; d.y = e.clientY;
    });
    const endDrag = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      const d = this.drag;
      if (!d) return;
      if (d.turning || (d.spin != null && d.moved)) { d.turning = false; this.settle(); }
      if (this.pointers.size === 0) { this.drag = null; svg.classList.remove("dragging"); }
      else if (d.pinch) {
        // один палец остался: дальше он двигает план от своей точки
        const [x, y] = [...this.pointers.values()][0];
        this.drag = { x, y, moved: true, target: null };
      }
      if (!d.moved && e.type === "pointerup") this.tap(e, d.target);
    };
    on("pointerup", endDrag);
    on("pointercancel", endDrag);
    on("pointerover", (e) => this.showTip(e));
    on("pointerout", (e) => { if ((e.target as Element).closest?.("[data-room], [data-place]")) this.hideTip(); });
  }

  private centerAngle(x: number, y: number) {
    const b = this.svg.getBoundingClientRect();
    return (Math.atan2(y - (b.top + b.height / 2), x - (b.left + b.width / 2)) * 180) / Math.PI;
  }

  private tap(e: PointerEvent, target: Element | null) {
    const s = getState();
    const room = (target?.closest?.("[data-room]") as SVGElement | null)?.dataset.room;
    const place = (target?.closest?.("[data-place]") as SVGElement | null)?.dataset.place;
    const p = this.worldPoint(e.clientX, e.clientY);
    if (NAV_DEBUG) console.log(`[${p.x.toFixed(1)}, ${p.y.toFixed(1)}]`, `этаж ${s.floor}`);
    const key = room ? "r:" + room : place;
    if (s.route.open && s.route.picking) pickPoint(p.x, p.y);
    else if (key && s.route.open && s.route.step < 0) tapPlaceInRoute(key);
    else if (room) selectRoom(room === s.room ? null : room);
    else if (place) selectPlace(place === s.place ? null : place);
  }

  /* ---------- подсказка: только для мыши, на тач-экране информацию даёт карточка */
  private showTip(e: PointerEvent) {
    if (e.pointerType !== "mouse" || this.drag) return;
    const r = (e.target as Element).closest?.("[data-room]") as SVGElement | null;
    if (!r) {
      const pl = getPlace(((e.target as Element).closest?.("[data-place]") as SVGElement | null)?.dataset.place);
      if (!pl) return;
      const i = placeInfo(pl);
      this.tip.innerHTML = `<b>${esc(pl.title)}</b><br><span style="opacity:.8">${esc(i.about || CATS[i.cat].name)}</span>`;
      this.tip.hidden = false;
      return;
    }
    const s = getState(), room = r.dataset.room!, st = roomStatus(room, s.date, s.t);
    let html = `<b>${esc(room)}</b><br>`;
    if (st.st === "busy") html += `Занята до ${fmt(st.until!)}<br><span style="opacity:.8">${esc(st.ev!.title)}</span>`;
    else if (st.until) html += `Свободна до ${fmt(st.until)}<br><span style="opacity:.8">Дальше: ${esc(st.next!.title)}</span>`;
    else html += "Свободна до конца дня";
    this.tip.innerHTML = html;
    this.tip.hidden = false;
  }
  private moveTip(e: PointerEvent) {
    if (this.tip.hidden) return;
    const box = this.wrap.getBoundingClientRect();
    let x = e.clientX - box.left + 14;
    const y = e.clientY - box.top + 14;
    if (x + 260 > box.width) x = e.clientX - box.left - 14 - this.tip.offsetWidth;
    this.tip.style.left = x + "px"; this.tip.style.top = y + "px";
  }
  hideTip() { this.tip.hidden = true; }

  /* ---------- отладка разметки: ?navdebug в адресе */
  private debugStops(parent: Element, n: number) {
    const g = el("g", { class: "nav-debug" }, parent);
    const dot = (x: number, y: number, text: string, color: string) => {
      el("circle", { cx: x, cy: y, r: 9, fill: color, opacity: 0.85 }, g);
      el("text", { x: x + 12, y: y + 4, "font-size": 13, fill: color, "font-weight": 600 }, g).textContent = text;
    };
    const cid = this.campus.id;
    for (const l of links(cid)) if (l.at[n]) dot(l.at[n][0], l.at[n][1], `${l.id} [${l.floors.join(",")}]`, l.kind === "lift" ? "#0a7" : "#e50");
    for (const e of NAV[cid]?.entrances || []) if (e.floor === n) dot(e.at[0], e.at[1], e.name, "#06f");
    for (const [f, x, y, k] of NAV[cid]?.wc || []) if (f === n) dot(x, y, "wc-" + k, "#a0a");
  }
}
