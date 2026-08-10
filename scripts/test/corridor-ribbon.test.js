'use strict';
// Regression tests for the island corridor-ribbon lane assignment
// (buildIslandCorridorFeatures / solveLaneSequence in heleon-tracker.html).
//
// The bug these guard against: lanes were assigned per 55 m grid cell from the
// route's INDEX in that cell's peer set. Independently-phased samples made the
// peer set churn cell-to-cell, and an index into a local set renumbers whenever
// a peer joins or leaves — so a single Kauaʻi route shattered into 507 features
// (median 45 m, 1,494 of them 2-vertex stubs) that each drew at a different
// offset. On the map that read as blobs and broken dashes.
//
// The code under test lives in the HTML (it's a browser function), so we extract
// it by line range and run it in Node. If someone moves it, these tests fail
// loudly rather than silently passing against nothing.
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../lib/paths');

function metersBetween(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toR, dLon = (b[0] - a[0]) * toR;
  const la1 = a[1] * toR, la2 = b[1] * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Pull the shipping implementation out of the client.
function loadImpl() {
  const html = fs.readFileSync(path.join(ROOT, 'heleon-tracker.html'), 'utf8');
  const lines = html.split('\n');
  const start = lines.findIndex(l => l.startsWith('const LANE_SWITCH_COST'));
  const end = lines.findIndex(l => l.startsWith('function renderIslandRouteLines'));
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('corridor-ribbon code not found in heleon-tracker.html — did it move or get renamed?');
  }
  const src = lines.slice(start, end).join('\n');
  if (!/function buildIslandCorridorFeatures/.test(src) || !/function solveLaneSequence/.test(src)) {
    throw new Error('extracted slice is missing the expected functions');
  }
  const factory = new Function('metersBetween', `
    let allPatternCoords = {}, routeVisible = {}, ROUTES_META = {};
    ${src}
    return {
      run(apc, meta, vis) {
        allPatternCoords = apc; routeVisible = vis || {}; ROUTES_META = meta || {};
        return buildIslandCorridorFeatures(meta || {});
      },
      solveLaneSequence,
    };
  `);
  return factory(metersBetween);
}

const impl = loadImpl();
const meta = ids => Object.fromEntries(ids.map(id => [id, { color: '#3388ff', name: id }]));
// Two routes sharing one long straight road — the canonical corridor.
const sharedCorridor = () => {
  const line = [];
  for (let i = 0; i < 400; i++) line.push([-157.88 + i * 0.0002, 21.30]);
  return { r001: [line], r002: [line.map(p => [p[0], p[1] + 0.00005])] };
};

module.exports = {
  'lane sequence is stable: no per-sample flicker on a shared corridor': () => {
  const data = sharedCorridor();
  const feats = impl.run(data, meta(Object.keys(data)), {});
  // Before the fix this produced hundreds of fragments; the whole point is that
  // a constant corridor yields a small, constant number of features.
  if (feats.length > 8) throw new Error(`expected a few long features, got ${feats.length}`);
  const stubs = feats.filter(f => f.geometry.coordinates.length === 2);
  if (stubs.length) throw new Error(`${stubs.length} two-vertex stub features (these render as blobs)`);
  },

  'co-traveling routes get distinct lanes': () => {
  const data = sharedCorridor();
  const feats = impl.run(data, meta(Object.keys(data)), {});
  const byRoute = {};
  for (const f of feats) byRoute[f.properties.routeId] = f.properties.slot;
  const slots = Object.values(byRoute);
  if (new Set(slots).size < 2) throw new Error(`routes share a lane (${JSON.stringify(byRoute)}) — they would overlap`);
  },

  'a crowded trunk keeps every route visible (no overflow onto centerline)': () => {
  // 20 routes on one road. The old code parked everything past MAX_LANES on
  // slot 0, hiding most of them under each other.
  const line = [];
  for (let i = 0; i < 300; i++) line.push([-157.88 + i * 0.0002, 21.30]);
  const data = {}, ids = [];
  for (let i = 0; i < 20; i++) { const id = 'r' + String(i).padStart(3, '0'); ids.push(id); data[id] = [line.map(p => [p[0], p[1] + i * 0.000002])]; }
  const feats = impl.run(data, meta(ids), {});
  const byRoute = {};
  for (const f of feats) byRoute[f.properties.routeId] = f.properties.slot;
  const distinct = new Set(Object.values(byRoute)).size;
  if (distinct < 20) throw new Error(`only ${distinct} distinct lanes for 20 routes — some are hidden`);
  },

  'geometry is preserved (no invented or dropped length)': () => {
  const data = sharedCorridor();
  const feats = impl.run(data, meta(Object.keys(data)), {});
  let drawn = 0;
  for (const f of feats) {
    const c = f.geometry.coordinates;
    for (let i = 1; i < c.length; i++) drawn += metersBetween(c[i - 1], c[i]);
  }
  let src = 0;
  for (const pats of Object.values(data)) for (const p of pats) for (let i = 1; i < p.length; i++) src += metersBetween(p[i - 1], p[i]);
  // Sampling means it won't match to the metre, but it must be the same road.
  if (Math.abs(drawn - src) / src > 0.05) throw new Error(`drawn length ${Math.round(drawn)}m vs source ${Math.round(src)}m`);
  },

  'respects routeVisible': () => {
  const data = sharedCorridor();
  const feats = impl.run(data, meta(Object.keys(data)), { r001: false, r002: false });
  if (feats.length) throw new Error(`hidden routes still drew ${feats.length} features`);
  },

  'degenerate input never yields broken geometry': () => {
  const cases = {
    empty: {},
    singlePoint: { r1: [[[0, 0]]] },
    duplicatePoints: { r1: [[[0, 0], [0, 0], [0, 0]]] },
    nullPatterns: { r1: [null, undefined, [[0, 0], [0.01, 0]]] },
    nanCoords: { r1: [[[0, 0], [NaN, NaN], [0.01, 0]]] },
    infiniteCoords: { r1: [[[0, 0], [Infinity, 0], [0.01, 0]]] },
    backtracking: { r1: [[[0, 0], [0.01, 0], [0, 0], [0.01, 0]]] },
    antimeridian: { r1: [[[179.999, 0], [-179.999, 0]]] },
  };
  for (const [name, data] of Object.entries(cases)) {
    let feats;
    try { feats = impl.run(data, meta(Object.keys(data)), {}); }
    catch (e) { throw new Error(`${name} threw: ${e.message}`); }
    for (const f of feats) {
      if (!Number.isFinite(f.properties.slot)) throw new Error(`${name}: non-finite slot`);
      if (f.geometry.coordinates.length < 2) throw new Error(`${name}: degenerate 1-point feature`);
      for (const c of f.geometry.coordinates) {
        if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) throw new Error(`${name}: non-finite coordinate`);
      }
    }
  }
  },

  'solveLaneSequence prefers holding a lane over chasing noise': () => {
  // One-sample blips must not trigger a lane change; a sustained run must.
  const ideal = [0, 0, 0, 0, 1, 0, 0, 0, 0];           // single blip
  const held = impl.solveLaneSequence(ideal, [0, 1], 20);
  if (held.some(l => l !== 0)) throw new Error(`blip caused a lane change: ${held.join(',')}`);

  const sustained = [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
  const moved = impl.solveLaneSequence(sustained, [0, 1], 20);
  if (moved[moved.length - 1] !== 1) throw new Error(`sustained change ignored: ${moved.join(',')}`);
  },
};
