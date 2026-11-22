// Sokoban solver — push-optimal per-room A*.
//
// The levels in this bounty are a hallway with 1-4 small rooms off it
// (each room 3-4 boxes, at most 6x6), and a box pushed out of its room
// can never come back, so the push-optimal total is the sum of the
// rooms' optima. The solver finds the hallway, splits the level into
// its rooms, solves each room on its own with a push-based A*, and
// stitches the rooms together with the player's walks between doors.
// A room is tiny, so its A* is exact: the heuristic is the minimum
// bipartite matching of boxes to goals over floor distances, and
// dead squares (by reverse reachability from the goals), 2x2 box
// blocks and frozen boxes are pruned. Only pushes cost; the player's
// walks between pushes are rebuilt with plain BFS.
//
// Determinism: every choice is fixed — direction order u, d, l, r,
// heap ties broken by depth then insertion order — and the search is
// budgeted by expansions, never by the clock. Two runs therefore
// write byte-identical outputs.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=<kit>/practice/input
//   MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Fixed direction order everywhere: up, down, left, right.
const DIRS = [
  { dx: 0, dy: -1, ch: 'u' },
  { dx: 0, dy: 1, ch: 'd' },
  { dx: -1, dy: 0, ch: 'l' },
  { dx: 1, dy: 0, ch: 'r' },
] as const;

interface Level {
  w: number;
  h: number;
  wall: boolean[];
  goals: number[];
  goalSet: Set<number>;
  boxes: number[];
  player: number;
}

function parse(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall: boolean[] = new Array(w * h).fill(true);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = 0;
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const ch = row[x] ?? '#';
      const i = y * w + x;
      wall[i] = ch === '#';
      if ('.*+'.includes(ch)) goals.push(i);
      if ('$*'.includes(ch)) boxes.push(i);
      if ('@+'.includes(ch)) player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, goalSet: new Set(goals), boxes, player };
}

function xy(w: number, i: number): [number, number] {
  return [i % w, (i / w) | 0];
}

// Neighbours of a square inside the board.
function neighbours(w: number, h: number, i: number): number[] {
  const [x, y] = xy(w, i);
  const out: number[] = [];
  for (const d of DIRS) {
    const nx = x + d.dx;
    const ny = y + d.dy;
    if (nx >= 0 && ny >= 0 && nx < w && ny < h) out.push(ny * w + nx);
  }
  return out;
}

// BFS distances from src over squares where scope is true and not a wall.
function bfsDist(lv: Level, scope: boolean[], src: number): Int32Array {
  const dist = new Int32Array(lv.w * lv.h).fill(-1);
  const q: number[] = [src];
  dist[src] = 0;
  for (let head = 0; head < q.length; head++) {
    const cur = q[head]!;
    for (const ni of neighbours(lv.w, lv.h, cur)) {
      if (dist[ni] !== -1 || lv.wall[ni] || !scope[ni]) continue;
      dist[ni] = dist[cur]! + 1;
      q.push(ni);
    }
  }
  return dist;
}

// All squares the player can reach from src without moving a box.
function floodRegion(lv: Level, scope: boolean[], boxSet: Set<number>, src: number): number[] {
  const seen = new Set<number>([src]);
  const q: number[] = [src];
  for (let head = 0; head < q.length; head++) {
    const cur = q[head]!;
    for (const ni of neighbours(lv.w, lv.h, cur)) {
      if (seen.has(ni) || lv.wall[ni] || !scope[ni] || boxSet.has(ni)) continue;
      seen.add(ni);
      q.push(ni);
    }
  }
  return [...seen].sort((a, b) => a - b);
}

// Squares a box can never be pushed off towards a goal: reverse
// reachability from the goals. A square s is live when some neighbour
// t is live and the square on the far side of s from t is open floor
// (the player could stand there to push s onto t). Anything not live
// is dead: a box on it can never reach a goal.
function deadSquares(lv: Level, scope: boolean[], goals: number[]): boolean[] {
  const live: boolean[] = new Array(lv.w * lv.h).fill(false);
  const q: number[] = [];
  for (const g of goals) {
    live[g] = true;
    q.push(g);
  }
  for (let head = 0; head < q.length; head++) {
    const t = q[head]!;
    const [tx, ty] = xy(lv.w, t);
    for (const d of DIRS) {
      const sx = tx - d.dx;
      const sy = ty - d.dy;
      const px = tx - 2 * d.dx;
      const py = ty - 2 * d.dy;
      if (sx < 0 || sy < 0 || sx >= lv.w || sy >= lv.h) continue;
      if (px < 0 || py < 0 || px >= lv.w || py >= lv.h) continue;
      const s = sy * lv.w + sx;
      const p = py * lv.w + px;
      if (live[s] || lv.wall[s] || !scope[s]) continue;
      if (lv.wall[p] || !scope[p]) continue;
      live[s] = true;
      q.push(s);
    }
  }
  return live.map((v) => !v);
}

// A box is frozen when it is blocked on both sides along both axes,
// where blocked means a wall or an already-frozen box. Frozen boxes
// never move again, so a frozen box off a goal deadlocks the state.
function hasFrozenBox(
  lv: Level,
  scope: boolean[],
  boxes: number[],
  goalSet: Set<number>,
): boolean {
  const frozen = new Set<number>();
  const blocked = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= lv.w || y >= lv.h) return true;
    const i = y * lv.w + x;
    if (lv.wall[i] || !scope[i]) return true;
    return frozen.has(i);
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of boxes) {
      if (frozen.has(b) || goalSet.has(b)) continue;
      const [x, y] = xy(lv.w, b);
      const blockedH = blocked(x - 1, y) && blocked(x + 1, y);
      const blockedV = blocked(x, y - 1) && blocked(x, y + 1);
      if (blockedH && blockedV) {
        frozen.add(b);
        changed = true;
      }
    }
  }
  return frozen.size > 0;
}

// Four boxes in a 2x2 block, none on a goal, can never be undone.
function hasBoxBlock(lv: Level, boxes: number[], goalSet: Set<number>): boolean {
  const boxSet = new Set(boxes);
  for (const b of boxes) {
    const [x, y] = xy(lv.w, b);
    if (x + 1 >= lv.w || y + 1 >= lv.h) continue;
    const c = b + 1;
    const d = b + lv.w;
    const e = b + lv.w + 1;
    if (boxSet.has(c) && boxSet.has(d) && boxSet.has(e)) {
      if (!goalSet.has(b) && !goalSet.has(c) && !goalSet.has(d) && !goalSet.has(e)) {
        return true;
      }
    }
  }
  return false;
}

function deadlocked(
  lv: Level,
  scope: boolean[],
  dead: boolean[],
  boxes: number[],
  goalSet: Set<number>,
): boolean {
  for (const b of boxes) {
    if (dead[b] && !goalSet.has(b)) return true;
  }
  if (hasBoxBlock(lv, boxes, goalSet)) return true;
  if (hasFrozenBox(lv, scope, boxes, goalSet)) return true;
  return false;
}

// Minimum-cost assignment of boxes to goals over floor distances.
// Admissible for push cost: every box needs at least its distance in
// pushes to reach its goal, and each push moves exactly one box.
function matchingHeuristic(
  boxes: number[],
  distFromGoal: Int32Array[],
): number {
  const n = boxes.length;
  const used: boolean[] = new Array(n).fill(false);
  let best = Infinity;
  const rec = (i: number, cost: number): void => {
    if (cost >= best) return;
    if (i === n) {
      best = cost;
      return;
    }
    for (let j = 0; j < n; j++) {
      if (used[j]) continue;
      const d = distFromGoal[j]![boxes[i]!];
      if (d < 0) continue;
      used[j] = true;
      rec(i + 1, cost + d);
      used[j] = false;
    }
  };
  rec(0, 0);
  return best;
}

// Cheaper admissible estimate for many boxes: each box's distance to
// its nearest goal, summed.
function nearestHeuristic(boxes: number[], distFromGoal: Int32Array[]): number {
  let total = 0;
  for (const b of boxes) {
    let m = Infinity;
    for (const dg of distFromGoal) {
      const d = dg[b];
      if (d >= 0 && d < m) m = d;
    }
    if (m === Infinity) return Infinity;
    total += m;
  }
  return total;
}

interface Push {
  from: number;
  to: number;
  ch: string;
}

// A binary heap ordered by (f, -g, insertion order): lowest f first,
// deeper states first on ties, oldest first after that. Fully
// deterministic.
class Heap {
  private f: number[] = [];
  private g: number[] = [];
  private seq: number[] = [];
  private idx: number[] = [];

  get size(): number {
    return this.f.length;
  }

  private less(a: number, b: number): boolean {
    if (this.f[a] !== this.f[b]) return this.f[a]! < this.f[b]!;
    if (this.g[a] !== this.g[b]) return this.g[a]! > this.g[b]!;
    return this.seq[a]! < this.seq[b]!;
  }

  push(f: number, g: number, seq: number, idx: number): void {
    const n = this.f.length;
    this.f.push(f);
    this.g.push(g);
    this.seq.push(seq);
    this.idx.push(idx);
    let i = n;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      for (const arr of [this.f, this.g, this.seq, this.idx]) {
        const t = arr[i]!;
        arr[i] = arr[p]!;
        arr[p] = t;
      }
      i = p;
    }
  }

  pop(): number {
    const top = this.idx[0]!;
    const last = this.f.length - 1;
    for (const arr of [this.f, this.g, this.seq, this.idx]) {
      arr[0] = arr[last]!;
      arr.pop();
    }
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.f.length) break;
      if (c + 1 < this.f.length && this.less(c + 1, c)) c++;
      if (!this.less(c, i)) break;
      for (const arr of [this.f, this.g, this.seq, this.idx]) {
        const t = arr[i]!;
        arr[i] = arr[c]!;
        arr[c] = t;
      }
      i = c;
    }
    return top;
  }
}

interface PushSolution {
  pushes: Push[];
  pushesCount: number;
  endPlayer: number;
}

// Push-based A* over (sorted boxes, player region). Cost is pushes.
// Returns the push sequence and the player's final square, or null
// when the expansion budget runs out.
function pushAStar(
  lv: Level,
  scope: boolean[],
  entry: number,
  startBoxes: number[],
  goals: number[],
  cap: number,
  useMatching: boolean,
): PushSolution | null {
  const goalSet = new Set(goals);
  const distFromGoal = goals.map((g) => bfsDist(lv, scope, g));
  const dead = deadSquares(lv, scope, goals);
  const heuristic = (boxes: number[]): number =>
    useMatching ? matchingHeuristic(boxes, distFromGoal) : nearestHeuristic(boxes, distFromGoal);

  const start = [...startBoxes].sort((a, b) => a - b);
  if (deadlocked(lv, scope, dead, start, goalSet)) return null;
  const startRegion = floodRegion(lv, scope, new Set(start), entry);

  const sBoxes: number[][] = [start];
  const sRegion: number[][] = [startRegion];
  const sPlayer: number[] = [entry];
  const sParent: number[] = [-1];
  const sPush: (Push | null)[] = [null];
  const sG: number[] = [0];
  const key = (boxes: number[], region: number[]): string =>
    `${boxes.join(',')}#${region.join(',')}`;
  const best = new Map<string, number>([[key(start, startRegion), 0]]);
  const hCache = new Map<string, number>();
  const hOf = (boxes: number[]): number => {
    const k = boxes.join(',');
    let v = hCache.get(k);
    if (v === undefined) {
      v = heuristic(boxes);
      hCache.set(k, v);
    }
    return v;
  };

  const heap = new Heap();
  let seq = 0;
  heap.push(hOf(start), 0, seq++, 0);
  let expanded = 0;
  while (heap.size > 0 && expanded < cap) {
    const si = heap.pop();
    const boxes = sBoxes[si]!;
    const region = sRegion[si]!;
    const g = sG[si]!;
    if (best.get(key(boxes, region)) !== g) continue;
    expanded++;
    if (boxes.every((b) => goalSet.has(b))) {
      const pushes: Push[] = [];
      let cur = si;
      while (sParent[cur] !== -1) {
        pushes.push(sPush[cur]!);
        cur = sParent[cur]!;
      }
      pushes.reverse();
      return { pushes, pushesCount: pushes.length, endPlayer: sPlayer[si]! };
    }
    const regionSet = new Set(region);
    const boxSet = new Set(boxes);
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      const [bx, by] = xy(lv.w, b);
      for (const d of DIRS) {
        const tx = bx + d.dx;
        const ty = by + d.dy;
        const px = bx - d.dx;
        const py = by - d.dy;
        if (tx < 0 || ty < 0 || tx >= lv.w || ty >= lv.h) continue;
        if (px < 0 || py < 0 || px >= lv.w || py >= lv.h) continue;
        const to = ty * lv.w + tx;
        const behind = py * lv.w + px;
        if (lv.wall[to] || !scope[to] || boxSet.has(to)) continue;
        if (lv.wall[behind] || !scope[behind] || boxSet.has(behind)) continue;
        if (!regionSet.has(behind)) continue;
        const nb = [...boxes];
        nb[bi] = to;
        nb.sort((a, b2) => a - b2);
        if (deadlocked(lv, scope, dead, nb, goalSet)) continue;
        const nRegion = floodRegion(lv, scope, new Set(nb), b);
        const k = key(nb, nRegion);
        const g2 = g + 1;
        if ((best.get(k) ?? Infinity) <= g2) continue;
        best.set(k, g2);
        const h = hOf(nb);
        if (h === Infinity) continue;
        sBoxes.push(nb);
        sRegion.push(nRegion);
        sPlayer.push(b);
        sParent.push(si);
        sPush.push({ from: b, to, ch: d.ch });
        sG.push(g2);
        heap.push(g2 + h, g2, seq++, sBoxes.length - 1);
      }
    }
  }
  return null;
}

// Shortest player walk from `from` to `to` over scope squares, treating
// `boxes` as obstacles. Returns the move letters, or null if unreachable.
function bfsWalk(
  lv: Level,
  scope: boolean[],
  boxes: number[],
  from: number,
  to: number,
): string | null {
  if (from === to) return '';
  const boxSet = new Set(boxes);
  const prev = new Map<number, { p: number; ch: string }>();
  const q: number[] = [from];
  prev.set(from, { p: -1, ch: '' });
  for (let head = 0; head < q.length; head++) {
    const cur = q[head]!;
    const [cx, cy] = xy(lv.w, cur);
    for (const d of DIRS) {
      const nx = cx + d.dx;
      const ny = cy + d.dy;
      if (nx < 0 || ny < 0 || nx >= lv.w || ny >= lv.h) continue;
      const ni = ny * lv.w + nx;
      if (prev.has(ni) || lv.wall[ni] || !scope[ni] || boxSet.has(ni)) continue;
      prev.set(ni, { p: cur, ch: d.ch });
      if (ni === to) {
        let s = '';
        let c = ni;
        while (prev.get(c)!.p !== -1) {
          s = prev.get(c)!.ch + s;
          c = prev.get(c)!.p;
        }
        return s;
      }
      q.push(ni);
    }
  }
  return null;
}

// Apply a move string to (boxes, player) on the whole level.
// Returns the new state, or null if a move is illegal.
function applyMoves(
  lv: Level,
  boxes: number[],
  player: number,
  moves: string,
): { boxes: number[]; player: number } | null {
  const bs = [...boxes];
  let p = player;
  for (const ch of moves) {
    const d = DIRS.find((x) => x.ch === ch);
    if (!d) return null;
    const [px, py] = xy(lv.w, p);
    const nx = px + d.dx;
    const ny = py + d.dy;
    if (nx < 0 || ny < 0 || nx >= lv.w || ny >= lv.h) return null;
    const ni = ny * lv.w + nx;
    if (lv.wall[ni]) return null;
    const bi = bs.indexOf(ni);
    if (bi >= 0) {
      const bx = nx + d.dx;
      const by = ny + d.dy;
      if (bx < 0 || by < 0 || bx >= lv.w || by >= lv.h) return null;
      const bni = by * lv.w + bx;
      if (lv.wall[bni] || bs.includes(bni)) return null;
      bs[bi] = bni;
    }
    p = ni;
  }
  return { boxes: bs, player: p };
}

interface Room {
  scope: boolean[];
  entry: number;
  boxes: number[];
  goals: number[];
}

// Split the level into rooms: remove the hallway (the player's row,
// or failing that the player's column) and take the connected
// components that hold boxes. A valid split has no box or goal on the
// hallway itself, equal boxes and goals per component, exactly one
// door square per component, and every box accounted for.
function decompose(lv: Level): Room[] | null {
  const lines: { isRow: boolean; idx: number }[] = [
    { isRow: true, idx: (lv.player / lv.w) | 0 },
    { isRow: false, idx: lv.player % lv.w },
  ];
  for (const line of lines) {
    const lineSet = new Set<number>();
    if (line.isRow) {
      for (let x = 0; x < lv.w; x++) lineSet.add(line.idx * lv.w + x);
    } else {
      for (let y = 0; y < lv.h; y++) lineSet.add(y * lv.w + line.idx);
    }
    let bad = false;
    for (const b of lv.boxes) if (lineSet.has(b)) bad = true;
    for (const g of lv.goals) if (lineSet.has(g)) bad = true;
    if (bad) continue;
    const seen = new Set<number>();
    const rooms: Room[] = [];
    let totalBoxes = 0;
    for (let i = 0; i < lv.w * lv.h; i++) {
      if (lv.wall[i] || lineSet.has(i) || seen.has(i)) continue;
      const comp: number[] = [];
      const q: number[] = [i];
      seen.add(i);
      for (let head = 0; head < q.length; head++) {
        const cur = q[head]!;
        comp.push(cur);
        for (const ni of neighbours(lv.w, lv.h, cur)) {
          if (lv.wall[ni] || lineSet.has(ni) || seen.has(ni)) continue;
          seen.add(ni);
          q.push(ni);
        }
      }
      const compSet = new Set(comp);
      const boxes = lv.boxes.filter((b) => compSet.has(b));
      const goals = lv.goals.filter((g) => compSet.has(g));
      if (boxes.length === 0 && goals.length === 0) continue;
      if (boxes.length !== goals.length) {
        bad = true;
        break;
      }
      const doors = comp.filter((s) =>
        neighbours(lv.w, lv.h, s).some(
          (n) => lineSet.has(n) && !lv.wall[n],
        ),
      );
      if (doors.length !== 1) {
        bad = true;
        break;
      }
      const door = doors[0]!;
      const entry = neighbours(lv.w, lv.h, door).find(
        (n) => lineSet.has(n) && !lv.wall[n],
      )!;
      const scope: boolean[] = new Array(lv.w * lv.h).fill(false);
      for (const s of comp) scope[s] = true;
      scope[entry] = true;
      rooms.push({ scope, entry, boxes, goals });
      totalBoxes += boxes.length;
    }
    if (bad) continue;
    if (rooms.length === 0 || totalBoxes !== lv.boxes.length) continue;
    return rooms;
  }
  return null;
}

// All orderings of the rooms, in a fixed deterministic order.
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) out.push([items[i]!, ...p]);
  }
  return out;
}

const ROOM_CAP = 400_000;
const ROOM_CAP_RETRY = 2_000_000;
const GLOBAL_CAP = 300_000;

function solveLevel(lv: Level): string {
  const openScope: boolean[] = new Array(lv.w * lv.h).fill(false);
  for (let i = 0; i < lv.w * lv.h; i++) openScope[i] = !lv.wall[i];

  // Whole-level fallback: one push A* with the cheaper heuristic.
  const global = (): string => {
    const sol = pushAStar(lv, openScope, lv.player, lv.boxes, lv.goals, GLOBAL_CAP, false);
    if (!sol) return '';
    return movesFromPushes(lv, openScope, lv.boxes, lv.player, sol);
  };

  const rooms = decompose(lv);
  if (!rooms) return global();

  // Solve each room once, from its door. Rooms are independent, so
  // their solutions do not depend on the order they are visited in.
  const solved: { room: Room; sol: PushSolution }[] = [];
  for (const room of rooms) {
    let sol = pushAStar(lv, room.scope, room.entry, room.boxes, room.goals, ROOM_CAP, true);
    if (!sol) {
      // One retry with a much larger work budget: a room that is
      // merely awkward still beats the whole-level fallback, which
      // cannot search a 12-box level at all. Still budgeted by work,
      // so the run stays deterministic.
      sol = pushAStar(lv, room.scope, room.entry, room.boxes, room.goals, ROOM_CAP_RETRY, true);
    }
    if (!sol) return global();
    solved.push({ room, sol });
  }

  // Try the visit orders until the player's walks between rooms all
  // succeed (a room whose final state blocks its own door must come
  // last, and the permutations find that order).
  for (const order of permutations(solved)) {
    let boxes = [...lv.boxes];
    let player = lv.player;
    let moves = '';
    let ok = true;
    for (const { room, sol } of order) {
      const walk = bfsWalk(lv, openScope, boxes, player, room.entry);
      if (walk === null) {
        ok = false;
        break;
      }
      moves += walk;
      player = room.entry;
      const roomMoves = movesFromPushes(lv, room.scope, room.boxes, room.entry, sol);
      const applied = applyMoves(lv, boxes, player, roomMoves);
      if (applied === null) {
        ok = false;
        break;
      }
      boxes = applied.boxes;
      player = applied.player;
      moves += roomMoves;
    }
    if (ok) return moves;
  }
  return global();
}

// Turn a room's push sequence into the full move string, rebuilding
// the player's walks between pushes with BFS.
function movesFromPushes(
  lv: Level,
  scope: boolean[],
  startBoxes: number[],
  startPlayer: number,
  sol: PushSolution,
): string {
  let boxes = [...startBoxes].sort((a, b) => a - b);
  let player = startPlayer;
  let moves = '';
  for (const p of sol.pushes) {
    const d = DIRS.find((x) => x.ch === p.ch)!;
    const [fx, fy] = xy(lv.w, p.from);
    const behind = (fy - d.dy) * lv.w + (fx - d.dx);
    const walk = bfsWalk(lv, scope, boxes, player, behind);
    if (walk === null) return '';
    moves += walk;
    moves += p.ch;
    const applied = applyMoves(lv, boxes, player, walk + p.ch);
    if (applied === null) return '';
    boxes = applied.boxes;
    player = applied.player;
  }
  return moves;
}

for (const id of readdirSync(I).sort()) {
  let moves = '';
  try {
    const lv = parse(readFileSync(join(I, id, 'level.txt'), 'utf8'));
    moves = solveLevel(lv);
  } catch {
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
