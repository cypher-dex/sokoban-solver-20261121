// Push-optimal Sokoban for make.fun's sokoban-solver-01 levels.
//
// A level is a one-square hallway with rooms off it; a box pushed into the hallway can never reach a goal, so every
// room is an independent puzzle and the level's push optimum is the sum of its rooms' optima. Each room is solved by
// A* over pushes (a state is the boxes plus the player's reachable region) with an admissible, consistent estimate:
// the cheapest assignment of boxes to distinct goals by push distance. Pruning: dead squares, frozen boxes (blocked on
// both axes by walls, dead squares or other frozen boxes) off their goals, and positions no assignment can finish.
// The search is bounded by state count, never by the clock, so two runs write the same bytes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const MAX_STATES = 1_500_000;
const INF = 1 << 28;
const LETTERS = ['u', 'd', 'l', 'r'];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

function parse(text: string): Level {
  const rows = text.split('\n').map((r) => r.replace(/\r$/, '')).filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  for (let y = 0; y < h; y++) {
    const row = rows[y]!;
    for (let x = 0; x < row.length; x++) {
      const c = row[x]!;
      const i = y * w + x;
      if (c === '#') continue;
      if (c === '-' || c === '_') {
        wall[i] = 0;
        continue;
      }
      wall[i] = 0;
      if (c === '.' || c === '*' || c === '+') goals.push(i);
      if (c === '$' || c === '*') boxes.push(i);
      if (c === '@' || c === '+') player = i;
    }
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/** dist[g][s]: pushes needed to bring a lone box from s onto goal g (reverse pulls over the walls alone). */
function pushDistances(lv: Level): Int32Array[] {
  const { w, wall, goals } = lv;
  const n = wall.length;
  const D = [-w, w, -1, 1];
  return goals.map((g) => {
    const dist = new Int32Array(n).fill(INF);
    dist[g] = 0;
    const q = [g];
    for (let qi = 0; qi < q.length; qi++) {
      const b = q[qi]!;
      for (const d of D) {
        // pull: box at b came from b - d, player stood at b - 2d
        const from = b - d;
        if (wall[from] || wall[from - d] || dist[from]! <= dist[b]! + 1) continue;
        dist[from] = dist[b]! + 1;
        q.push(from);
      }
    }
    return dist;
  });
}

/** Cheapest assignment of boxes to distinct goals (exact; boxes per room are few). */
function assignment(boxes: ArrayLike<number>, nb: number, dist: Int32Array[]): number {
  const ng = dist.length;
  // DP over subsets of goals.
  const full = 1 << ng;
  let cur = new Int32Array(full).fill(INF);
  cur[0] = 0;
  for (let i = 0; i < nb; i++) {
    const next = new Int32Array(full).fill(INF);
    const b = boxes[i]!;
    for (let m = 0; m < full; m++) {
      const c = cur[m]!;
      if (c >= INF) continue;
      for (let g = 0; g < ng; g++) {
        if (m & (1 << g)) continue;
        const d = dist[g]![b]!;
        if (d >= INF) continue;
        const nm = m | (1 << g);
        if (c + d < next[nm]!) next[nm] = c + d;
      }
    }
    cur = next;
  }
  let best = INF;
  for (let m = 0; m < full; m++) if (cur[m]! < best) best = cur[m]!;
  return best;
}

/** Shortest walk from a to b avoiding walls and boxes, in lower LURD letters. */
function walk(lv: Level, occ: Uint8Array, a: number, b: number): string {
  if (a === b) return '';
  const { w, wall } = lv;
  const D = [-w, w, -1, 1];
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Int8Array(wall.length);
  prev[a] = a;
  const q = [a];
  for (let qi = 0; qi < q.length && prev[b] === -1; qi++) {
    const p = q[qi]!;
    for (let k = 0; k < 4; k++) {
      const t = p + D[k]!;
      if (wall[t] || occ[t] || prev[t] !== -1) continue;
      prev[t] = p;
      how[t] = k;
      q.push(t);
    }
  }
  if (prev[b] === -1) throw new Error('unreachable');
  let s = '';
  for (let p = b; p !== a; p = prev[p]!) s = LETTERS[how[p]!] + s;
  return s;
}

/** A* over pushes for one (sub)level. Returns the moves (pushes upper-case) or null on budget exhaustion. */
function solve(lv: Level, maxStates: number): string | null {
  const { w, wall, goals } = lv;
  const n = wall.length;
  const nb = lv.boxes.length;
  if (nb === 0) return '';
  if (goals.length < nb) return null;
  const D = [-w, w, -1, 1];
  const dist = pushDistances(lv);
  const goal = new Uint8Array(n);
  for (const g of goals) goal[g] = 1;
  const live = new Uint8Array(n);
  for (let s = 0; s < n; s++) for (const d of dist) if (d[s]! < INF) live[s] = 1;
  for (const b of lv.boxes) if (!live[b]) return null;

  const occ = new Uint8Array(n);
  // seen: the expanded state's region; mark: each child's region (only its lowest square is kept).
  const seen = new Int32Array(n);
  const mark = new Int32Array(n);
  const stack = new Int32Array(n);
  let stamp = 0;
  // Marks the player's region from `from` in `into` with a fresh stamp; returns its lowest square (the region's name).
  const region = (from: number, into: Int32Array): number => {
    stamp++;
    let low = from;
    let sp = 0;
    stack[sp++] = from;
    into[from] = stamp;
    while (sp > 0) {
      const p = stack[--sp]!;
      if (p < low) low = p;
      for (let k = 0; k < 4; k++) {
        const q = p + D[k]!;
        if (!wall[q] && !occ[q] && into[q] !== stamp) {
          into[q] = stamp;
          stack[sp++] = q;
        }
      }
    }
    return low;
  };

  // Frozen-box deadlock: a box is frozen when blocked on both axes; an axis is blocked by a wall on either side,
  // dead squares on both sides, or a neighbouring box that is itself frozen (with this box treated as a wall).
  const tmpWall = new Uint8Array(n);
  const blockedAxis = (b: number, d: number): boolean => {
    const a = b - d;
    const c = b + d;
    if (wall[a] || wall[c] || tmpWall[a] || tmpWall[c]) return true;
    if (!live[a] && !live[c]) return true;
    tmpWall[b] = 1;
    let r = false;
    if (occ[a] && frozen(a)) r = true;
    else if (occ[c] && frozen(c)) r = true;
    tmpWall[b] = 0;
    return r;
  };
  const frozen = (b: number): boolean => blockedAxis(b, 1) && blockedAxis(b, w);
  const deadlockAt = (t: number): boolean => {
    if (!frozen(t)) return false;
    // A frozen group is fine only if every box in it sits on a goal; check t and its frozen neighbours.
    if (!goal[t]) return true;
    for (const d of D) {
      const q = t + d;
      if (occ[q] && !goal[q] && frozen(q)) return true;
    }
    return false;
  };

  const keyOf = (bx: ArrayLike<number>, low: number): string => {
    let k = String.fromCharCode(low);
    for (let i = 0; i < nb; i++) k += String.fromCharCode(bx[i]!);
    return k;
  };

  // State storage.
  let cap = 1 << 16;
  let sBoxes = new Uint16Array(cap * nb);
  let sPlayer = new Int32Array(cap);
  let sParent = new Int32Array(cap);
  let sG = new Int32Array(cap);
  let sClosed = new Uint8Array(cap);
  let count = 0;
  const grow = () => {
    cap *= 2;
    const nbx = new Uint16Array(cap * nb);
    nbx.set(sBoxes);
    sBoxes = nbx;
    const np = new Int32Array(cap);
    np.set(sPlayer);
    sPlayer = np;
    const npa = new Int32Array(cap);
    npa.set(sParent);
    sParent = npa;
    const ng = new Int32Array(cap);
    ng.set(sG);
    sG = ng;
    const nc = new Uint8Array(cap);
    nc.set(sClosed);
    sClosed = nc;
  };
  const index = new Map<string, number>();

  // Binary heap ordered by f, then larger g, then insertion order.
  const hf: number[] = [];
  const hg: number[] = [];
  const hi: number[] = [];
  const less = (a: number, b: number) => hf[a]! < hf[b]! || (hf[a] === hf[b] && (hg[a]! > hg[b]! || (hg[a] === hg[b] && hi[a]! < hi[b]!)));
  const swap = (a: number, b: number) => {
    [hf[a], hf[b]] = [hf[b]!, hf[a]!];
    [hg[a], hg[b]] = [hg[b]!, hg[a]!];
    [hi[a], hi[b]] = [hi[b]!, hi[a]!];
  };
  const hpush = (f: number, g: number, id: number) => {
    let i = hf.length;
    hf.push(f);
    hg.push(g);
    hi.push(id);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(i, p)) break;
      swap(i, p);
      i = p;
    }
  };
  const hpop = (): number => {
    const top = hi[0]!;
    const last = hf.length - 1;
    swap(0, last);
    hf.pop();
    hg.pop();
    hi.pop();
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < hf.length && less(l, m)) m = l;
      if (r < hf.length && less(r, m)) m = r;
      if (m === i) break;
      swap(i, m);
      i = m;
    }
    return top;
  };

  const h0 = assignment(lv.boxes, nb, dist);
  if (h0 >= INF) return null;
  for (const b of lv.boxes) occ[b] = 1;
  const low0 = region(lv.player, mark);
  for (const b of lv.boxes) occ[b] = 0;
  sBoxes.set(lv.boxes, 0);
  sPlayer[0] = lv.player;
  sParent[0] = -1;
  sG[0] = 0;
  count = 1;
  index.set(keyOf(lv.boxes, low0), 0);
  hpush(h0, 0, 0);

  const cur = new Uint16Array(nb);
  const next = new Uint16Array(nb);
  let found = -1;
  while (hf.length > 0) {
    const id = hpop();
    if (sClosed[id]) continue;
    sClosed[id] = 1;
    const g = sG[id]!;
    for (let i = 0; i < nb; i++) cur[i] = sBoxes[id * nb + i]!;
    let done = true;
    for (let i = 0; i < nb; i++) if (!goal[cur[i]!]) done = false;
    if (done) {
      found = id;
      break;
    }
    for (let i = 0; i < nb; i++) occ[cur[i]!] = 1;
    region(sPlayer[id]!, seen);
    const here = stamp;
    for (let bi = 0; bi < nb; bi++) {
      const b = cur[bi]!;
      for (let k = 0; k < 4; k++) {
        const d = D[k]!;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occ[t] || !live[t]) continue;
        occ[b] = 0;
        occ[t] = 1;
        let skip = deadlockAt(t);
        let key = '';
        let h = INF;
        if (!skip) {
          let j = 0;
          for (let i = 0; i < nb; i++) {
            const v = i === bi ? t : cur[i]!;
            next[j++] = v;
          }
          next.sort();
          h = assignment(next, nb, dist);
          if (h >= INF) skip = true;
          else key = keyOf(next, region(b, mark));
        }
        occ[t] = 0;
        occ[b] = 1;
        if (skip) continue;
        const prevId = index.get(key);
        if (prevId !== undefined) {
          if (sG[prevId]! <= g + 1) continue;
          // Consistent heuristic: a cheaper path to an unexpanded state replaces it.
          sG[prevId] = g + 1;
          sParent[prevId] = id;
          sPlayer[prevId] = b;
          hpush(g + 1 + h, g + 1, prevId);
          continue;
        }
        if (count >= maxStates) {
          for (let i = 0; i < nb; i++) occ[cur[i]!] = 0;
          return null;
        }
        if (count >= cap) grow();
        sBoxes.set(next, count * nb);
        sPlayer[count] = b;
        sParent[count] = id;
        sG[count] = g + 1;
        index.set(key, count);
        hpush(g + 1 + h, g + 1, count);
        count++;
      }
    }
    for (let i = 0; i < nb; i++) occ[cur[i]!] = 0;
  }
  if (found < 0) return null;

  const path: number[] = [];
  for (let s = found; s > 0; s = sParent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = lv.player;
  let boxes = Array.from(lv.boxes);
  for (const s of path) {
    const nx = Array.from(sBoxes.subarray(s * nb, s * nb + nb));
    const from = boxes.find((b) => !nx.includes(b))!;
    const to = nx.find((b) => !boxes.includes(b))!;
    const d = to - from;
    const k = D.indexOf(d);
    for (const b of boxes) occ[b] = 1;
    moves += walk(lv, occ, player, from - d);
    for (const b of boxes) occ[b] = 0;
    moves += LETTERS[k]!.toUpperCase();
    player = from;
    boxes = nx;
  }
  return moves;
}

/** Rooms: floor components left after removing the dead squares of the player's row (the hallway). */
function rooms(lv: Level): { boxes: number[]; goals: number[] }[] | null {
  const { w, wall, goals, boxes, player } = lv;
  const dist = pushDistances(lv);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && dist.every((d) => d[i]! >= INF)) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const out: { boxes: number[]; goals: number[] }[] = [];
  const D = [-w, w, -1, 1];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    part[s] = out.length;
    const q = [s];
    for (let qi = 0; qi < q.length; qi++)
      for (const d of D) {
        const t = q[qi]! + d;
        if (!wall[t] && !cut[t] && part[t] < 0) {
          part[t] = out.length;
          q.push(t);
        }
      }
    out.push({ boxes: [], goals: [] });
  }
  for (const b of boxes) out[part[b]!]!.boxes.push(b);
  for (const g of goals) {
    if (part[g]! < 0) return null;
    out[part[g]!]!.goals.push(g);
  }
  if (out.some((r) => r.boxes.length !== r.goals.length)) return null;
  return out.filter((r) => r.boxes.length > 0);
}

function endOf(w: number, p: number, moves: string): number {
  for (const c of moves.toLowerCase()) p += c === 'u' ? -w : c === 'd' ? w : c === 'l' ? -1 : 1;
  return p;
}

function solveLevel(text: string): string {
  const lv = parse(text);
  if (lv.player < 0) return '';
  const parts = rooms(lv);
  if (parts !== null && parts.length > 1) {
    let player = lv.player;
    let moves = '';
    const doneGoals: number[][] = [];
    for (const room of parts) {
      const wall = lv.wall.slice();
      for (const other of parts) if (other !== room) for (const b of doneGoals.includes(other.goals) ? other.goals : other.boxes) wall[b] = 1;
      const sub: Level = { ...lv, wall, goals: room.goals.slice().sort((a, b) => a - b), boxes: room.boxes.slice().sort((a, b) => a - b), player };
      const m = solve(sub, MAX_STATES);
      if (m === null) return solve(lv, MAX_STATES) ?? '';
      moves += m;
      player = endOf(lv.w, player, m);
      doneGoals.push(room.goals);
    }
    return moves;
  }
  return solve(lv, MAX_STATES) ?? '';
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
