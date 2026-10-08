// graph.js: graph algorithms. A graph is just "things" (nodes) joined by "links" (edges) that have a cost.
// MRT stations are nodes and ride times are edge costs. Candidate venues in a multi-stop plan form layers.
//
// What is here, and what each is for:
//   dijkstra / estimateTransitMinutes : shortest travel time through the MRT network (fallback when OneMap fails)
//   orderGreedy / orderExact / twoOpt : best ORDER to visit several stops (greedy shown as the baseline to beat)
//   planChain / chainGreedy           : pick one venue per stage (food -> activity -> food) with the lowest TOTAL cost
//   clusterByDistance                 : group nearby venues (union-find) so results can be shown by area

import { haversineKm } from './geo.js';

// ---------------------------------------------------------------- min-heap (priority queue)
class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item, pri) {
    const a = this.a; a.push([item, pri]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][1] <= a[i][1]) break;
      [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l][1] < a[m][1]) m = l;
        if (r < a.length && a[r][1] < a[m][1]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

// ---------------------------------------------------------------- Dijkstra
/**
 * Shortest path from one or more source nodes to every other node. Costs must not be negative.
 * Idea: always expand the closest unfinished node; once a node is popped, its distance is final.
 * @param {Map<string, {to:string, w:number}[]>} adj
 * @param {string[]} sources all start at distance 0 (several sources = "start from any of these")
 */
function dijkstra(adj, sources) {
  const dist = new Map(), prev = new Map(), heap = new MinHeap();
  for (const s of sources) { dist.set(s, 0); heap.push(s, 0); }
  while (heap.size) {
    const [u, d] = heap.pop();
    if (d > (dist.get(u) ?? Infinity)) continue; // stale entry
    for (const { to, w } of adj.get(u) ?? []) {
      const nd = d + w;
      if (nd < (dist.get(to) ?? Infinity)) { dist.set(to, nd); prev.set(to, u); heap.push(to, nd); }
    }
  }
  return { dist, prev };
}

/**
 * Build a transit graph. Modelling lesson: a node is (station, line), not just a station, so changing
 * lines can cost extra time. Without this, Dijkstra would treat an interchange as free.
 * @param {{line:string, from:string, to:string, minutes:number}[]} edges
 */
function buildTransitGraph(edges, transferMinutes = 4) {
  const adj = new Map(), stationLines = new Map();
  const node = (s, l) => `${s}|${l}`;
  const link = (a, b, w) => {
    if (!(w >= 0)) throw new Error('buildTransitGraph: minutes must be >= 0');
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push({ to: b, w });
  };
  for (const e of edges) {
    link(node(e.from, e.line), node(e.to, e.line), e.minutes);
    link(node(e.to, e.line), node(e.from, e.line), e.minutes);
    for (const s of [e.from, e.to]) {
      if (!stationLines.has(s)) stationLines.set(s, new Set());
      stationLines.get(s).add(e.line);
    }
  }
  for (const [s, lines] of stationLines) {
    const ls = [...lines];
    for (const x of ls) for (const y of ls) if (x !== y) link(node(s, x), node(s, y), transferMinutes);
  }
  return { adj, stationLines, node };
}

/** Fastest ride between two stations, with the station path. Infinity if unreachable. */
function rideMinutes(graph, fromStation, toStation) {
  const from = graph.stationLines.get(fromStation), to = graph.stationLines.get(toStation);
  if (!from) throw new Error(`rideMinutes: unknown station ${fromStation}`);
  if (!to) throw new Error(`rideMinutes: unknown station ${toStation}`);
  if (fromStation === toStation) return { minutes: 0, path: [fromStation] };
  const { dist, prev } = dijkstra(graph.adj, [...from].map(l => graph.node(fromStation, l)));
  let best = Infinity, bestNode = null;
  for (const l of to) {
    const d = dist.get(graph.node(toStation, l)) ?? Infinity;
    if (d < best) { best = d; bestNode = graph.node(toStation, l); }
  }
  if (bestNode === null) return { minutes: Infinity, path: [] };
  const path = [];
  for (let n = bestNode; n !== undefined; n = prev.get(n)) path.push(n.split('|')[0]);
  path.reverse();
  return { minutes: best, path: path.filter((s, i) => s !== path[i - 1]) };
}

/**
 * Fallback travel time when the routing API fails: walk to the nearest station, ride (Dijkstra),
 * walk from the nearest station to the destination. Compared against just walking. Label as "approximate" in the UI.
 * @param net { graph, stations: {name: [lat, lng]} }
 */
function estimateTransitMinutes(from, to, net, { walkKmh = 4.5, waitMinutes = 5, detour = 1.3 } = {}) {
  const walk = km => (km * detour * 60) / walkKmh;
  const nearest = p => Object.entries(net.stations)
    .map(([name, [lat, lng]]) => ({ name, km: haversineKm(p, { lat, lng }) }))
    .sort((a, b) => a.km - b.km)[0];
  const direct = walk(haversineKm(from, to));
  const a = nearest(from), b = nearest(to);
  const ride = rideMinutes(net.graph, a.name, b.name);
  const transit = walk(a.km) + waitMinutes + ride.minutes + walk(b.km);
  return transit < direct
    ? { minutes: transit, mode: 'transit', via: ride.path }
    : { minutes: direct, mode: 'walk', via: [] };
}

// ---------------------------------------------------------------- ordering stops
const legTotal = (route, cost) => route.slice(1).reduce((s, p, i) => s + cost(route[i], p), 0);

/** GREEDY baseline: always go to the nearest unvisited stop. Fast, but can be far from optimal. */
function orderGreedy(start, stops, cost, end = null) {
  const left = [...stops], order = []; let cur = start;
  while (left.length) {
    let bi = 0;
    for (let i = 1; i < left.length; i++) if (cost(cur, left[i]) < cost(cur, left[bi])) bi = i;
    cur = left.splice(bi, 1)[0]; order.push(cur);
  }
  return { order, total: legTotal([start, ...order, ...(end ? [end] : [])], cost) };
}

/**
 * EXACT best order (Held-Karp dynamic programming). dp[mask][j] = cheapest way to start at `start`,
 * visit exactly the stops in `mask`, and finish at stop j. Cost grows like 2^n x n^2, which is trivial
 * for the 3 to 8 stops a day plan has, so there is no reason to settle for greedy.
 */
function orderExact(start, stops, cost, end = null) {
  const n = stops.length;
  if (n === 0) return { order: [], total: end ? cost(start, end) : 0 };
  if (n > 12) throw new Error('orderExact: up to 12 stops. Use orderGreedy + twoOpt beyond that.');
  const full = (1 << n) - 1;
  const dp = Array.from({ length: 1 << n }, () => new Array(n).fill(Infinity));
  const parent = Array.from({ length: 1 << n }, () => new Array(n).fill(-1));
  for (let j = 0; j < n; j++) dp[1 << j][j] = cost(start, stops[j]);
  for (let mask = 1; mask <= full; mask++) {
    for (let j = 0; j < n; j++) {
      if (!(mask & (1 << j)) || dp[mask][j] === Infinity) continue;
      for (let k = 0; k < n; k++) {
        if (mask & (1 << k)) continue;
        const nm = mask | (1 << k), c = dp[mask][j] + cost(stops[j], stops[k]);
        if (c < dp[nm][k]) { dp[nm][k] = c; parent[nm][k] = j; }
      }
    }
  }
  let best = Infinity, last = -1;
  for (let j = 0; j < n; j++) {
    const t = dp[full][j] + (end ? cost(stops[j], end) : 0);
    if (t < best) { best = t; last = j; }
  }
  const order = []; let mask = full;
  for (let j = last; j !== -1;) { order.push(stops[j]); const pj = parent[mask][j]; mask ^= 1 << j; j = pj; }
  return { order: order.reverse(), total: best };
}

/**
 * 2-opt local search: start from the greedy order and keep reversing a section of the route whenever that
 * makes it shorter. Not guaranteed optimal, but much better than greedy and works for many stops.
 */
function twoOpt(start, stops, cost, end = null) {
  let route = [start, ...orderGreedy(start, stops, cost, end).order, ...(end ? [end] : [])];
  const lastMovable = route.length - 1 - (end ? 1 : 0);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < lastMovable; i++) {
      for (let j = i + 1; j <= lastMovable; j++) {
        const cand = [...route.slice(0, i), ...route.slice(i, j + 1).reverse(), ...route.slice(j + 1)];
        if (legTotal(cand, cost) < legTotal(route, cost) - 1e-12) { route = cand; improved = true; }
      }
    }
  }
  return { order: route.slice(1, lastMovable + 1), total: legTotal(route, cost) };
}

// ---------------------------------------------------------------- one venue per stage
/**
 * Layered shortest path (dynamic programming). stages = [[venues for food], [venues for activity], ...].
 * best[stage][k] = penalty(k) + min over previous j of (best[stage-1][j] + cost(j, k)).
 * Minimises the TOTAL (start -> stage 1 -> stage 2 -> ... -> end), including the trip home.
 * Cost O(stages x k^2). Greedy would pick the nearest option at each stage and can get stuck far from home.
 */
function planChain(stages, start, end, cost, penalty = () => 0) {
  if (stages.length === 0) return { path: [], total: end ? cost(start, end) : 0 };
  let prevBest = stages[0].map(v => cost(start, v) + penalty(v));
  const parents = [stages[0].map(() => -1)];
  for (let s = 1; s < stages.length; s++) {
    const cur = [], par = [];
    for (const v of stages[s]) {
      let bj = 0, bc = Infinity;
      stages[s - 1].forEach((u, j) => { const c = prevBest[j] + cost(u, v); if (c < bc) { bc = c; bj = j; } });
      cur.push(bc + penalty(v)); par.push(bj);
    }
    prevBest = cur; parents.push(par);
  }
  const lastStage = stages[stages.length - 1];
  let bk = 0, bt = Infinity;
  lastStage.forEach((v, k) => { const t = prevBest[k] + (end ? cost(v, end) : 0); if (t < bt) { bt = t; bk = k; } });
  const path = [];
  for (let s = stages.length - 1, k = bk; s >= 0; k = parents[s][k], s--) path.push(stages[s][k]);
  return { path: path.reverse(), total: bt };
}

/** GREEDY baseline for comparison: cheapest next stop at each stage, ignoring where that leaves you. */
function chainGreedy(stages, start, end, cost, penalty = () => 0) {
  const path = []; let cur = start, total = 0;
  for (const options of stages) {
    let best = options[0], bc = Infinity;
    for (const v of options) { const c = cost(cur, v) + penalty(v); if (c < bc) { bc = c; best = v; } }
    path.push(best); total += bc; cur = best;
  }
  if (end) total += cost(cur, end);
  return { path, total };
}

// ---------------------------------------------------------------- clustering
/**
 * Union-find: link any two items closer than thresholdKm, then return the connected groups.
 * Use it to present "3 options around Bugis" instead of one long list.
 */
function clusterByDistance(items, thresholdKm, getPoint = x => x) {
  const parent = items.map((_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (haversineKm(getPoint(items[i]), getPoint(items[j])) <= thresholdKm) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  items.forEach((it, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(it); });
  return [...groups.values()];
}

export {
  MinHeap, dijkstra, buildTransitGraph, rideMinutes, estimateTransitMinutes,
  orderGreedy, orderExact, twoOpt, planChain, chainGreedy, clusterByDistance,
};
