'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('./mrt-graph.json');
const G = require('./graph');
const { haversineKm } = require('./geo');

const graph = G.buildTransitGraph(net.edges, net.transferMinutes);
const abs = (a, b) => Math.abs(a - b);

// ---- heap + dijkstra ----
test('MinHeap pops in order', () => {
  const h = new G.MinHeap(); [5, 1, 4, 2, 3].forEach(x => h.push(x, x));
  const out = []; while (h.size) out.push(h.pop()[0]);
  assert.deepStrictEqual(out, [1, 2, 3, 4, 5]);
});
test('dijkstra: a longer route with fewer cost beats the direct edge', () => {
  const adj = new Map([['A', [{ to: 'B', w: 10 }, { to: 'C', w: 1 }]], ['C', [{ to: 'B', w: 2 }]], ['B', []]]);
  const { dist, prev } = G.dijkstra(adj, ['A']);
  assert.strictEqual(dist.get('B'), 3);
  assert.strictEqual(prev.get('B'), 'C');
});
test('transit graph: simple ride, transfer penalty, and unreachable/unknown stations', () => {
  assert.strictEqual(G.rideMinutes(graph, 'Tampines', 'Paya Lebar').minutes, 14);
  // Tampines -> Dakota needs a change at Paya Lebar: 14 ride + 4 transfer + 5 ride
  const t = G.rideMinutes(graph, 'Tampines', 'Dakota');
  assert.strictEqual(t.minutes, 23);
  assert.deepStrictEqual(t.path, ['Tampines', 'Paya Lebar', 'Dakota']);
  assert.strictEqual(G.rideMinutes(graph, 'Bugis', 'Bugis').minutes, 0);
  assert.throws(() => G.rideMinutes(graph, 'Nowhere', 'Bugis'), /unknown station/);
});
test('transit graph: an interchange is NOT free (modelling (station, line) nodes)', () => {
  const noPenalty = G.rideMinutes(G.buildTransitGraph(net.edges, 0), 'Tampines', 'Dakota').minutes;
  assert.strictEqual(noPenalty, 19);
  assert.ok(G.rideMinutes(graph, 'Tampines', 'Dakota').minutes > noPenalty);
});
test('transit graph: the network is connected (every station reaches every other)', () => {
  const names = Object.keys(net.stations);
  for (const s of names) assert.ok(Number.isFinite(G.rideMinutes(graph, 'Bishan', s).minutes), `Bishan -> ${s}`);
});
test('estimateTransitMinutes: far trips use transit, very short trips just walk', () => {
  const stations = Object.fromEntries(Object.entries(net.stations));
  const n = { graph, stations };
  const woodlands = { lat: 1.4370, lng: 103.7865 }, tampines = { lat: 1.3541, lng: 103.9454 };
  const far = G.estimateTransitMinutes(woodlands, tampines, n);
  assert.strictEqual(far.mode, 'transit');
  assert.ok(far.minutes > 30 && far.minutes < 150, `got ${far.minutes}`);
  const near = G.estimateTransitMinutes({ lat: 1.3008, lng: 103.8555 }, { lat: 1.3012, lng: 103.8560 }, n);
  assert.strictEqual(near.mode, 'walk');
});

// ---- ordering stops: greedy vs exact ----
const line = (a, b) => Math.abs(a - b); // 1-D cost: stops are numbers on a line
test('orderGreedy is beaten by orderExact on a simple line', () => {
  // start 0; stops at 1, -2, 3.  Greedy: 0->1->3->-2 = 1+2+5 = 8.  Best: 0->-2->1->3 = 2+3+2 = 7.
  const greedy = G.orderGreedy(0, [1, -2, 3], line);
  const exact = G.orderExact(0, [1, -2, 3], line);
  assert.deepStrictEqual(greedy.order, [1, 3, -2]);
  assert.strictEqual(greedy.total, 8);
  assert.deepStrictEqual(exact.order, [-2, 1, 3]);
  assert.strictEqual(exact.total, 7);
});
test('orderExact agrees with brute-force permutations (random 2D points)', () => {
  const rnd = (() => { let s = 42; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; })();
  const pt = () => ({ lat: 1.28 + rnd() * 0.15, lng: 103.75 + rnd() * 0.2 });
  const perms = a => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map(p => [x, ...p])));
  for (let trial = 0; trial < 5; trial++) {
    const start = pt(), end = pt(), stops = [pt(), pt(), pt(), pt(), pt()];
    const total = o => [start, ...o, end].slice(1).reduce((s, p, i) => s + haversineKm([start, ...o, end][i], p), 0);
    const best = Math.min(...perms(stops).map(total));
    assert.ok(abs(G.orderExact(start, stops, haversineKm, end).total, best) < 1e-9);
  }
});
test('twoOpt is never worse than greedy, and never better than exact', () => {
  const rnd = (() => { let s = 7; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; })();
  for (let trial = 0; trial < 5; trial++) {
    const pts = Array.from({ length: 7 }, () => ({ lat: 1.28 + rnd() * 0.15, lng: 103.75 + rnd() * 0.2 }));
    const [start, ...stops] = pts;
    const g = G.orderGreedy(start, stops, haversineKm).total, t = G.twoOpt(start, stops, haversineKm).total, e = G.orderExact(start, stops, haversineKm).total;
    assert.ok(t <= g + 1e-9 && e <= t + 1e-9, `greedy ${g} twoOpt ${t} exact ${e}`);
  }
});
test('ordering handles empty and one stop, and a fixed end', () => {
  assert.deepStrictEqual(G.orderExact(0, [], line, 5), { order: [], total: 5 });
  assert.deepStrictEqual(G.orderExact(0, [3], line, 0).order, [3]);
  assert.throws(() => G.orderExact(0, Array.from({ length: 13 }, (_, i) => i), line), /up to 12/);
});

// ---- chain: one venue per stage ----
test('planChain beats greedy when the cheapest first step leads somewhere bad', () => {
  // start 0. Stage 1: A=+1, B=-3.  Stage 2: C=+4, D=-4.  Home is at -5.
  const stages = [[1, -3], [4, -4]], start = 0, end = -5;
  const greedy = G.chainGreedy(stages, start, end, line);   // 0->1 (1), 1->4 (3), 4->-5 (9) = 13
  const best = G.planChain(stages, start, end, line);       // 0->-3 (3), -3->-4 (1), -4->-5 (1) = 5
  assert.deepStrictEqual(greedy.path, [1, 4]);
  assert.strictEqual(greedy.total, 13);
  assert.deepStrictEqual(best.path, [-3, -4]);
  assert.strictEqual(best.total, 5);
});
test('planChain: penalties (e.g. a bad rating) are part of the total, and empty input is fine', () => {
  const stages = [[1, 2]];
  const best = G.planChain(stages, 0, null, line, v => (v === 1 ? 10 : 0)); // 1 is nearer but penalised
  assert.deepStrictEqual(best.path, [2]);
  assert.deepStrictEqual(G.planChain([], 0, 5, line), { path: [], total: 5 });
});

// ---- clustering ----
test('clusterByDistance groups by area', () => {
  const pts = [
    { id: 'bugis1', lat: 1.3000, lng: 103.8560 }, { id: 'bugis2', lat: 1.3020, lng: 103.8590 },
    { id: 'tamp1', lat: 1.3541, lng: 103.9446 }, { id: 'tamp2', lat: 1.3535, lng: 103.9445 },
  ];
  const groups = G.clusterByDistance(pts, 1).map(g => g.map(p => p.id).sort());
  assert.deepStrictEqual(groups.sort(), [['bugis1', 'bugis2'], ['tamp1', 'tamp2']]);
  assert.strictEqual(G.clusterByDistance(pts, 0.001).length, 4);
});
