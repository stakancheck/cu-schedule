/* Маршруты по кампусу.
 *
 * Каждый этаж растеризуем в сетку проходимости прямо из векторов плана:
 * пол - можно, стены и пустоты (атриум) - нельзя. Проёмы в стенах и есть
 * двери, поэтому путь сам находит выходы из аудиторий. Через чужие
 * помещения идти дорого, у стен чуть дороже, чем посередине коридора.
 *
 * Между этажами ходим по связям из nav/data.ts (лестницы и лифты).
 * Верхний уровень - маленький граф: старт, финиш и остановки связей,
 * расстояния между ними по этажам считаем Дейкстрой по сетке.
 */
import type { Campus, PlanRoom, Pt, VPath } from "../types";
import { NAV, type Link } from "./data";

const CELL = 4;          // единиц плана в клетке
const ROOM_COST = 6;     // множитель шага внутри чужого помещения
const WALL_NEAR = 5;     // клеток: ближе к стене шаг дороже
const WALL_COST = 1.2;
export const SPEED = 1.2; // м/с, спокойный шаг
const MIN_AREA = 300;    // клеток: меньшие карманы считаем артефактами растра

type Kind = Link["kind"];
// Профили: какие связи можно использовать
const PROFILES: Record<string, Record<Kind, boolean>> = {
  fast: { stairs: true, lift: true },
  lift: { stairs: false, lift: true },
  stairs: { stairs: true, lift: false },
};
// Время на связь в секундах. Лестница вверх медленнее, чем вниз.
export const rideTime = (kind: Kind, from: number, to: number) => {
  const n = Math.abs(to - from);
  if (kind === "lift") return 40 + 6 * n;          // ожидание + ход кабины
  return (to > from ? 16 : 11) * n;
};

const CAMPUSES = window.CAMPUSES;
const isCowork = (r: PlanRoom) => /Коворкинг|Опенспейс/.test(r.label || "") && !/сотрудник/.test(r.label || "");

/* ============================================================ Сетка этажа */
export interface Grid {
  campus: string; n: number; x0: number; y0: number; W: number; H: number;
  free: Uint8Array; room: Int16Array; rooms: string[]; cost: Float32Array;
  comp: Int32Array; compSize: number[]; minComp: number; mainComp: number;
  pairs: { stops: Stop[]; d: Map<string, number> } | null;
}
export type NavLink = Link & { floors: number[] };
interface Stop { link: NavLink; cell: number }

const grids = new Map<string, Grid>();

export function grid(campusId: string, n: number) {
  const key = campusId + ":" + n;
  let g = grids.get(key);
  if (!g) { g = buildGrid(CAMPUSES[campusId], n); grids.set(key, g); }
  return g;
}

function makeContext(w: number, h: number) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h).getContext("2d", { willReadFrequently: true })!;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c.getContext("2d", { willReadFrequently: true })!;
}

function buildGrid(campus: Campus, n: number): Grid {
  const f = campus.floors[n];
  const [x0, y0, x1, y1] = f.extent;
  const W = Math.ceil((x1 - x0) / CELL), H = Math.ceil((y1 - y0) / CELL), N = W * H;
  const ctx = makeContext(W, H);
  const paint = (paths: VPath[]) => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.setTransform(1 / CELL, 0, 0, 1 / CELL, -x0 / CELL, -y0 / CELL);
    for (const p of paths) ctx.fill(new Path2D(p.d), p.eo ? "evenodd" : "nonzero");
    return ctx.getImageData(0, 0, W, H).data;
  };
  const floorA = paint(f.floorPaths);
  // Стена, задевшая клетку хоть немного, её закрывает: иначе тонкие
  // наклонные стены растр пропускает насквозь.
  const wallA = paint([...f.wallPaths, ...f.voidPaths]);
  const free = new Uint8Array(N);
  for (let i = 0; i < N; i++) free[i] = floorA[i * 4 + 3] >= 128 && wallA[i * 4 + 3] < 20 ? 1 : 0;

  // Помещения: номер помещения в клетке (-1 - коридор или открытая зона)
  const room = new Int16Array(N).fill(-1);
  const rooms: string[] = [];
  f.rooms.forEach((r) => {
    if (!r.pts || r.pts.length < 3 || isCowork(r)) return;
    const idx = rooms.length;
    rooms.push(r.id);
    const xs = r.pts.map((p) => p[0]), ys = r.pts.map((p) => p[1]);
    const cx0 = Math.max(0, Math.floor((Math.min(...xs) - x0) / CELL)), cx1 = Math.min(W - 1, Math.ceil((Math.max(...xs) - x0) / CELL));
    const cy0 = Math.max(0, Math.floor((Math.min(...ys) - y0) / CELL)), cy1 = Math.min(H - 1, Math.ceil((Math.max(...ys) - y0) / CELL));
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        if (inPoly(x0 + (cx + 0.5) * CELL, y0 + (cy + 0.5) * CELL, r.pts)) room[cy * W + cx] = idx;
      }
    }
  });

  // Расстояние до ближайшей стены (фаска 1 / 1.4), дальше WALL_NEAR не считаем
  const dist = new Float32Array(N);
  for (let i = 0; i < N; i++) dist[i] = free[i] ? WALL_NEAR : 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!dist[i]) continue;
      let d = dist[i];
      if (x > 0) d = Math.min(d, dist[i - 1] + 1);
      if (y > 0) {
        d = Math.min(d, dist[i - W] + 1);
        if (x > 0) d = Math.min(d, dist[i - W - 1] + 1.4);
        if (x < W - 1) d = Math.min(d, dist[i - W + 1] + 1.4);
      }
      dist[i] = d;
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      if (!dist[i]) continue;
      let d = dist[i];
      if (x < W - 1) d = Math.min(d, dist[i + 1] + 1);
      if (y < H - 1) {
        d = Math.min(d, dist[i + W] + 1);
        if (x < W - 1) d = Math.min(d, dist[i + W + 1] + 1.4);
        if (x > 0) d = Math.min(d, dist[i + W - 1] + 1.4);
      }
      dist[i] = d;
    }
  }
  const cost = new Float32Array(N);
  for (let i = 0; i < N; i++) cost[i] = free[i] ? 1 + (WALL_COST * (WALL_NEAR - dist[i])) / WALL_NEAR : Infinity;

  // Связные области (по 4 соседям, как и ходим): отсекаем мелкие карманы
  const comp = new Int32Array(N).fill(-1), compSize: number[] = [];
  const stack = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    if (!free[i] || comp[i] >= 0) continue;
    const id = compSize.length;
    let sp = 0, size = 0;
    stack[sp++] = i; comp[i] = id;
    while (sp) {
      const c = stack[--sp];
      size++;
      const x = c % W;
      for (const j of [x > 0 ? c - 1 : -1, x < W - 1 ? c + 1 : -1, c - W, c + W]) {
        if (j >= 0 && j < N && free[j] && comp[j] < 0) { comp[j] = id; stack[sp++] = j; }
      }
    }
    compSize.push(size);
  }

  // Минимальная область, куда можно поставить точку: доля от основной зоны этажа.
  // Лестничные башни Дуката нарисованы без дверей и выходят замкнутыми карманами,
  // такие точки переносим к ближайшему месту в коридоре.
  const mainComp = compSize.indexOf(Math.max(0, ...compSize));
  const minComp = Math.max(MIN_AREA, (compSize[mainComp] || 0) * 0.05);
  return { campus: campus.id, n, x0, y0, W, H, free, room, rooms, cost, comp, compSize, minComp, mainComp, pairs: null };
}

export function inPoly(x: number, y: number, pts: Pt[]) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const pointOf = (g: Grid, i: number): Pt => [g.x0 + ((i % g.W) + 0.5) * CELL, g.y0 + (Math.floor(i / g.W) + 0.5) * CELL];

// Ближайшая проходимая клетка из заметной области (иконка лестницы может
// лежать на стене, подпись входа - за контуром здания)
function snap(g: Grid, x: number, y: number, maxR = 45, onlyComp = -1) {
  const cx = Math.floor((x - g.x0) / CELL), cy = Math.floor((y - g.y0) / CELL);
  let best = -1, bestD = Infinity;
  const test = (x2: number, y2: number) => {
    if (x2 < 0 || y2 < 0 || x2 >= g.W || y2 >= g.H) return;
    const i = y2 * g.W + x2;
    if (!g.free[i] || g.compSize[g.comp[i]] < g.minComp || (onlyComp >= 0 && g.comp[i] !== onlyComp)) return;
    const d = Math.hypot(x2 - cx, y2 - cy);
    if (d < bestD) { bestD = d; best = i; }
  };
  // кольца растущего радиуса, обходим только их периметр
  for (let r = 0; r <= maxR && r <= bestD; r++) {
    if (!r) { test(cx, cy); continue; }
    for (let d = -r; d <= r; d++) {
      test(cx + d, cy - r); test(cx + d, cy + r);
      if (d > -r && d < r) { test(cx - r, cy + d); test(cx + r, cy + d); }
    }
  }
  return best;
}

/* ============================================================ Поиск по сетке */
class Heap {
  k = new Float64Array(1024);
  v = new Int32Array(1024);
  n = 0;
  push(key: number, val: number) {
    if (this.n === this.k.length) {
      const k = new Float64Array(this.n * 2), v = new Int32Array(this.n * 2);
      k.set(this.k); v.set(this.v); this.k = k; this.v = v;
    }
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= key) break;
      this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p;
    }
    this.k[i] = key; this.v[i] = val;
  }
  pop() {
    const top = this.v[0], key = this.k[--this.n], val = this.v[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && this.k[c + 1] < this.k[c]) c++;
      if (this.k[c] >= key) break;
      this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c;
    }
    this.k[i] = key; this.v[i] = val;
    return top;
  }
}

interface SearchOpts { targets?: number[] | null; goal?: number; exempt?: Set<number> | null; prev?: boolean }

// Дейкстра (или A*, если задана одна цель goal) от нескольких источников.
// exempt - помещения, по которым идём без штрафа (откуда и куда идём).
function search(g: Grid, sources: number[], { targets = null, goal = -1, exempt = null, prev = false }: SearchOpts = {}) {
  const { W, H, cost, room } = g, N = W * H;
  const d = new Float32Array(N).fill(Infinity);
  const done = new Uint8Array(N);
  const from = prev ? new Int32Array(N).fill(-1) : null;
  const heap = new Heap();
  const gx = goal >= 0 ? goal % W : 0, gy = goal >= 0 ? Math.floor(goal / W) : 0;
  const h = goal >= 0 ? (i: number) => Math.hypot((i % W) - gx, Math.floor(i / W) - gy) : () => 0;
  const stepCost = (i: number) => {
    const r = room[i];
    return r >= 0 && !(exempt && exempt.has(r)) ? cost[i] * ROOM_COST : cost[i];
  };
  for (const s of sources) {
    if (s < 0) continue;
    d[s] = 0;
    heap.push(h(s), s);
  }
  const left = targets ? new Set(targets) : null;
  while (heap.n) {
    const c = heap.pop();
    if (done[c]) continue;
    done[c] = 1;
    if (c === goal) break;
    if (left && left.delete(c) && !left.size) break;
    const x = c % W, y = (c - x) / W, cc = stepCost(c);
    for (let dy = -1; dy <= 1; dy++) {
      const y2 = y + dy;
      if (y2 < 0 || y2 >= H) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const x2 = x + dx;
        if (x2 < 0 || x2 >= W) continue;
        const j = y2 * W + x2;
        if (done[j] || cost[j] === Infinity) continue;
        // по диагонали только если оба боковых шага свободны: не срезаем углы стен
        if (dx && dy && (cost[y * W + x2] === Infinity || cost[y2 * W + x] === Infinity)) continue;
        const nd = d[c] + ((dx && dy) ? Math.SQRT2 : 1) * (cc + stepCost(j)) / 2;
        if (nd < d[j]) {
          d[j] = nd;
          if (from) from[j] = c;
          heap.push(nd + h(j), j);
        }
      }
    }
  }
  return { d, from };
}

// Путь клетками -> ломаная: спрямляем, пока прямая не заходит в клетки
// дороже тех, по которым шёл исходный путь (стены, чужие комнаты)
function smooth(g: Grid, cells: number[], exempt: Set<number>) {
  if (cells.length < 3) return cells.map((c) => pointOf(g, c));
  const { W, cost, room } = g;
  const pen = (i: number) => (room[i] >= 0 && !exempt.has(room[i]) ? cost[i] * ROOM_COST : cost[i]);
  const clear = (a: number, b: number, limit: number) => {
    const ax = a % W, ay = Math.floor(a / W), bx = b % W, by = Math.floor(b / W);
    const n = Math.ceil(Math.hypot(bx - ax, by - ay) * 2);
    for (let k = 1; k < n; k++) {
      const x = Math.round(ax + ((bx - ax) * k) / n), y = Math.round(ay + ((by - ay) * k) / n);
      const i = y * W + x;
      if (cost[i] === Infinity || pen(i) > limit + 0.05) return false;
    }
    return true;
  };
  const out = [cells[0]];
  let anchor = 0, limit = pen(cells[0]);
  for (let j = 1; j < cells.length; j++) {
    const lim = Math.max(limit, pen(cells[j]));
    if (!clear(cells[anchor], cells[j], lim)) {
      anchor = j - 1;
      out.push(cells[anchor]);
      limit = Math.max(pen(cells[anchor]), pen(cells[j]));
    } else limit = lim;
  }
  out.push(cells[cells.length - 1]);
  return out.map((c) => pointOf(g, c));
}

function walkPath(g: Grid, a: number, b: number, exempt: Set<number>) {
  const { from } = search(g, [a], { goal: b, exempt, prev: true });
  const cells: number[] = [];
  for (let c = b; c >= 0; c = from![c]) { cells.push(c); if (c === a) break; }
  if (cells[cells.length - 1] !== a) return null;
  return smooth(g, cells.reverse(), exempt);
}
const polyLen = (pts: Pt[]) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);

/* ============================================================ Связи */
export function links(campusId: string): NavLink[] {
  const c = CAMPUSES[campusId];
  return (NAV[campusId]?.links || []).filter((l) => !l.closed)
    .map((l) => ({ ...l, floors: Object.keys(l.at).map(Number).filter((n) => c.floors[n]).sort((a, b) => a - b) }))
    .filter((l) => l.floors.length > 1);
}

// Остановки связей на этаже: клетка сетки для каждой
function stops(g: Grid, ls: NavLink[]) {
  const out: Stop[] = [];
  for (const l of ls) {
    const p = l.at[g.n];
    if (!p) continue;
    const cell = snap(g, p[0], p[1]);
    if (cell >= 0) out.push({ link: l, cell });
  }
  return out;
}

// Расстояния между остановками на этаже пересадки (кэш на сетке)
function pairs(g: Grid, ls: NavLink[]) {
  if (g.pairs) return g.pairs;
  const st = stops(g, ls), res = new Map<string, number>();
  for (const a of st) {
    const others = st.filter((b) => b !== a).map((b) => b.cell);
    if (!others.length) continue;
    const { d } = search(g, [a.cell], { targets: others });
    for (const b of st) if (b !== a && d[b.cell] < Infinity) res.set(a.link.id + ">" + b.link.id, d[b.cell]);
  }
  g.pairs = { stops: st, d: res };
  return g.pairs;
}

// Точка старта или финиша. Если она в области, откуда не выйти ни к одной
// лестнице и ни к другой точке маршрута (зал без нарисованной двери), берём
// ближайшее место основной зоны этажа.
function placeCell(g: Grid, ls: NavLink[], x: number, y: number, other = -1) {
  const c = snap(g, x, y);
  if (c < 0) return c;
  const ok = new Set(stops(g, ls).map((s) => g.comp[s.cell]));
  if (ok.has(g.comp[c]) || (other >= 0 && g.comp[other] === g.comp[c])) return c;
  const m = snap(g, x, y, 200, g.mainComp);
  return m >= 0 ? m : c;
}

/* ============================================================ Маршрут */
export interface GoalPoint { floor: number; x: number; y: number; title?: string }
// campus заполняется только в маршруте между кампусами, иначе отрезок в кампусе маршрута
export type WalkLeg = { type: "walk"; floor: number; pts: Pt[]; len: number; fromLink: NavLink | null; toLink: NavLink | null; campus?: string };
export type RideLeg = { type: "ride"; link: NavLink; kind: Kind; from: number; to: number; time: number; at: Pt; fromAt: Pt; campus?: string };
export type Leg = WalkLeg | RideLeg;
export interface RouteOption { profile: string; legs: Leg[]; goal: GoalPoint; walk: number; time: number; kinds: Kind[] }
export type PlanResult = { error: string; options?: undefined } | { options: RouteOption[]; error?: undefined };

interface Edge { b: string; w: number }

/* from: { floor, x, y }
 * to:   { floor, x, y } или { points: [...] } - «ближайший из» */
export function plan(campusId: string, from: GoalPoint, to: GoalPoint | { points: GoalPoint[] }): PlanResult {
  const meters = NAV[campusId]?.metersPerUnit || 0.042;
  const ls = links(campusId);
  const g0 = grid(campusId, from.floor);
  const sCell = placeCell(g0, ls, from.x, from.y);
  if (sCell < 0) return { error: "Не нашёл, откуда начать путь" };

  const many = "points" in to;
  let goals = many ? to.points : [to];
  // «Ближайший»: сначала на своём этаже, если там есть
  if (many && goals.some((p) => p.floor === from.floor)) goals = goals.filter((p) => p.floor === from.floor);
  const goalFloors = [...new Set(goals.map((p) => p.floor))];
  const gcells = new Map<number, { cell: number; goal: GoalPoint }[]>();
  for (const n of goalFloors) {
    const g = grid(campusId, n);
    gcells.set(n, goals.filter((p) => p.floor === n)
      .map((p) => ({ cell: placeCell(g, ls, p.x, p.y, n === from.floor ? sCell : -1), goal: p })).filter((x) => x.cell >= 0));
  }

  // Помещения старта и финиша проходим без штрафа
  const exemptOn = (n: number) => {
    const g = grid(campusId, n), s = new Set<number>();
    if (n === from.floor && g.room[sCell] >= 0) s.add(g.room[sCell]);
    for (const { cell } of gcells.get(n) || []) if (g.room[cell] >= 0) s.add(g.room[cell]);
    return s;
  };

  // Этажи, где можно пересесть с одной связи на другую: концы связей
  const lo = Math.min(from.floor, ...goalFloors), hi = Math.max(from.floor, ...goalFloors);
  const transfer = new Set<number>();
  for (const l of ls) for (const n of [l.floors[0], l.floors[l.floors.length - 1]]) {
    if (n >= lo && n <= hi) transfer.add(n);
  }

  // Узлы: "S", "G@этаж", "связь@этаж"
  const edges = new Map<string, Edge[]>();
  const add = (a: string, b: string, w: number) => {
    if (w < Infinity) (edges.get(a) || edges.set(a, []).get(a)!).push({ b, w });
  };
  const unitsToSec = (u: number) => (u * CELL * meters) / SPEED;

  {
    const st = stops(g0, ls);
    const gc = gcells.get(from.floor) || [];
    const { d } = search(g0, [sCell], { targets: [...st.map((s) => s.cell), ...gc.map((x) => x.cell)], exempt: exemptOn(from.floor) });
    for (const s of st) add("S", s.link.id + "@" + from.floor, unitsToSec(d[s.cell]));
    for (const x of gc) add("S", "G@" + from.floor, unitsToSec(d[x.cell]));
  }
  for (const n of goalFloors) {
    const g = grid(campusId, n), gc = gcells.get(n)!;
    if (!gc.length) continue;
    const st = stops(g, ls);
    const { d } = search(g, gc.map((x) => x.cell), { targets: st.map((s) => s.cell), exempt: exemptOn(n) });
    for (const s of st) add(s.link.id + "@" + n, "G@" + n, unitsToSec(d[s.cell]));
  }
  for (const n of transfer) {
    if (n === from.floor) continue;
    for (const [k, v] of pairs(grid(campusId, n), ls).d) {
      const [a, b] = k.split(">");
      add(a + "@" + n, b + "@" + n, unitsToSec(v));
    }
  }
  const rides: { a: string; b: string; w: number; kind: Kind }[] = [];
  for (const l of ls) {
    for (const a of l.floors) for (const b of l.floors) {
      if (a === b || (l.oneway === "up" && b < a) || (l.oneway === "down" && b > a)) continue;
      rides.push({ a: l.id + "@" + a, b: l.id + "@" + b, w: rideTime(l.kind, a, b), kind: l.kind });
    }
  }

  const found: { profile: string; sig: string; nodes: string[] }[] = [];
  for (const [pid, prof] of Object.entries(PROFILES)) {
    const path = shortest(edges, rides.filter((r) => prof[r.kind]));
    if (!path) continue;
    const sig = path.filter((x) => x !== "S" && !x.startsWith("G@")).join(",");
    if (found.some((o) => o.sig === sig)) continue;
    found.push({ profile: pid, sig, nodes: path });
  }
  if (!found.length) return { error: "Не получилось проложить маршрут: похоже, эти места не связаны на плане" };

  const linkById = Object.fromEntries(ls.map((l) => [l.id, l]));
  const built = found.map((o) => buildLegs(campusId, o, { from, sCell, gcells, exemptOn, linkById, meters }))
    .filter((o): o is RouteOption => !!o)
    .sort((a, b) => a.time - b.time);
  if (!built.length) return { error: "Не получилось проложить маршрут" };
  return { options: built };
}

// Дейкстра по маленькому графу узлов
function shortest(edges: Map<string, Edge[]>, rides: { a: string; b: string; w: number }[]) {
  const adj = new Map([...edges].map(([k, v]) => [k, [...v]]));
  for (const r of rides) (adj.get(r.a) || adj.set(r.a, []).get(r.a)!).push({ b: r.b, w: r.w });
  const dist = new Map([["S", 0]]), prev = new Map<string, string>(), done = new Set<string>();
  for (;;) {
    let u: string | null = null, du = Infinity;
    for (const [k, v] of dist) if (!done.has(k) && v < du) { u = k; du = v; }
    if (u === null) return null;
    if (u.startsWith("G@")) {
      const nodes = [u];
      while (prev.has(nodes[0])) nodes.unshift(prev.get(nodes[0])!);
      return nodes;
    }
    done.add(u);
    for (const e of adj.get(u) || []) {
      const nd = du + e.w;
      if (nd < (dist.get(e.b) ?? Infinity)) { dist.set(e.b, nd); prev.set(e.b, u); }
    }
  }
}

interface LegCtx {
  from: GoalPoint; sCell: number; gcells: Map<number, { cell: number; goal: GoalPoint }[]>;
  exemptOn: (n: number) => Set<number>; linkById: Record<string, NavLink>; meters: number;
}

// Узлы -> шаги: пешие отрезки с ломаной и переходы по связям
function buildLegs(campusId: string, o: { profile: string; nodes: string[] }, { from, sCell, gcells, exemptOn, linkById, meters }: LegCtx): RouteOption | null {
  const legs: Leg[] = [];
  let cur = { floor: from.floor, cell: sCell, link: null as NavLink | null };
  let goal: GoalPoint | null = null;
  for (let i = 1; i < o.nodes.length; i++) {
    const [id, ns] = o.nodes[i].split("@"), n = +ns;
    const g = grid(campusId, n);
    if (id === "G") {
      // из нескольких целей берём ту, до которой ближе от текущей точки
      let best: { pts: Pt[]; goal: GoalPoint } | null = null;
      for (const x of gcells.get(n)!) {
        const pts = walkPath(g, cur.cell, x.cell, exemptOn(n));
        if (pts && (!best || polyLen(pts) < polyLen(best.pts))) best = { pts, goal: x.goal };
      }
      if (!best) return null;
      goal = best.goal;
      legs.push({ type: "walk", floor: n, pts: best.pts, len: polyLen(best.pts) * meters, fromLink: cur.link, toLink: null });
      break;
    }
    const link = linkById[id];
    const st = stops(g, [link])[0];
    if (!st) return null;
    if (n === cur.floor) {
      const pts = walkPath(g, cur.cell, st.cell, exemptOn(n));
      if (!pts) return null;
      legs.push({ type: "walk", floor: n, pts, len: polyLen(pts) * meters, fromLink: cur.link, toLink: link });
    } else {
      legs.push({ type: "ride", link, kind: link.kind, from: cur.floor, to: n, time: rideTime(link.kind, cur.floor, n),
        at: pointOf(g, st.cell), fromAt: pointOf(grid(campusId, cur.floor), cur.cell) });
    }
    cur = { floor: n, cell: st.cell, link };
  }
  if (!goal) return null;
  let walk = 0, ride = 0;
  const kinds = new Set<Kind>();
  for (const l of legs) {
    if (l.type === "walk") walk += l.len;
    else { ride += l.time; kinds.add(l.kind); }
  }
  return { profile: o.profile, legs, goal, walk, time: walk / SPEED + ride, kinds: [...kinds] };
}

/* ============================================================ Отладка */
// Картинка сетки: непроходимое красное, замкнутые карманы оранжевые, помещения синие
export function debugImage(campusId: string, n: number) {
  const g = grid(campusId, n);
  const cv = document.createElement("canvas");
  cv.width = g.W; cv.height = g.H;
  const ctx = cv.getContext("2d")!, img = ctx.createImageData(g.W, g.H);
  for (let i = 0; i < g.W * g.H; i++) {
    const o = i * 4;
    if (!g.free[i]) { img.data[o] = 230; img.data[o + 3] = 60; continue; }
    if (g.compSize[g.comp[i]] < g.minComp) { img.data[o] = 255; img.data[o + 1] = 160; img.data[o + 3] = 200; continue; }
    if (g.room[i] >= 0) { img.data[o + 2] = 255; img.data[o + 3] = 50; }
    else { img.data[o + 1] = 180; img.data[o + 3] = Math.round(90 * (g.cost[i] - 1) / WALL_COST); }
  }
  ctx.putImageData(img, 0, 0);
  return { href: cv.toDataURL(), x: g.x0, y: g.y0, w: g.W * CELL, h: g.H * CELL };
}

// Можно ли встать в эту точку: рядом есть проходимая клетка основной зоны
export const canStand = (campusId: string, n: number, x: number, y: number) => snap(grid(campusId, n), x, y, 6) >= 0;
