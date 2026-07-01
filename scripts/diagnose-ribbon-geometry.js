'use strict';
/**
 * Geometry-quality diagnostic for the route-ribbon layer AS THE CLIENT DRAWS IT.
 *
 * diagnose-route-connectivity.js checks the *matcher* output (are the road
 * edges one connected chain per route). This tool goes one step further: it
 * replicates the CLIENT's render pipeline from heleon-tracker.html
 * (chainRouteEdges → smoothPolyline) against data/route-edges.json and measures
 * whether the result LOOKS like a clean metro map:
 *
 *   - runs        : how many separate polyline features a route becomes. A
 *                   clean route is a small handful of long runs; dozens of tiny
 *                   runs = the "disjointed mess" look.
 *   - fragments   : runs shorter than FRAG_M meters (visible little stubs).
 *   - kinks       : interior vertices whose turn angle is sharper than KINK_DEG
 *                   AFTER smoothing (hard corners that should be rounded).
 *   - lanejumps   : places a route's slot changes between touching edges, which
 *                   forces a run split and a visible parallel-offset step.
 *
 * Usage: node scripts/diagnose-ribbon-geometry.js [routeId]
 *   Reads data/route-edges.json (already built).
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const FRAG_M = 60;      // a run shorter than this is a visible stub
const KINK_DEG = 45;    // interior turn sharper than this reads as a hard corner

const onlyRoute = process.argv[2] && !process.argv[2].startsWith('--') ? String(process.argv[2]) : null;

const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/route-edges.json'), 'utf8'));

function distM(a, b) {
  const mPerDegLat = 111320, mPerDegLon = mPerDegLat * Math.cos(a[1] * Math.PI / 180);
  return Math.hypot((b[0] - a[0]) * mPerDegLon, (b[1] - a[1]) * mPerDegLat);
}
function polylineLenM(c) { let l = 0; for (let i = 1; i < c.length; i++) l += distM(c[i - 1], c[i]); return l; }

const _ptKey = (p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;

// ── Mirror of heleon-tracker.html chainRouteEdges (constant-slot runs) ──────
function chainRouteEdges(edges) {
  const remaining = edges.map((e, i) => ({ i, coords: e.coords, slot: e.slot, used: false }));
  const byEnd = new Map();
  for (const e of remaining) {
    for (const end of [e.coords[0], e.coords[e.coords.length - 1]]) {
      const k = _ptKey(end);
      if (!byEnd.has(k)) byEnd.set(k, []);
      byEnd.get(k).push(e);
    }
  }
  const runs = [];
  for (const start of remaining) {
    if (start.used) continue;
    start.used = true;
    let coords = start.coords.slice();
    const slots = [start.slot];
    const extend = () => {
      let progress = true;
      while (progress) {
        progress = false;
        const tail = coords[coords.length - 1];
        const prev = coords[coords.length - 2] || tail;
        const cands = (byEnd.get(_ptKey(tail)) || []).filter(c => !c.used);
        if (!cands.length) break;
        let best = cands[0], bestTurn = Infinity;
        for (const c of cands) {
          const cc = _ptKey(c.coords[0]) === _ptKey(tail) ? c.coords : c.coords.slice().reverse();
          const t = turnDeg(prev, tail, cc[1] || tail);
          if (t < bestTurn) { bestTurn = t; best = c; }
        }
        best.used = true;
        slots.push(best.slot);
        const nc = _ptKey(best.coords[0]) === _ptKey(tail) ? best.coords : best.coords.slice().reverse();
        coords = coords.concat(nc.slice(1));
        progress = true;
      }
    };
    extend();
    coords.reverse();
    extend();
    coords.reverse();
    slots.sort((a, b) => a - b);
    runs.push({ coords, slot: slots[Math.floor(slots.length / 2)] });
  }
  return runs;
}

function smoothPolyline(coords, passes = 3) {
  if (coords.length < 3) return coords;
  let pts = coords;
  for (let p = 0; p < passes; p++) {
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      out.push([a[0] + (b[0] - a[0]) * 0.25, a[1] + (b[1] - a[1]) * 0.25]);
      out.push([a[0] + (b[0] - a[0]) * 0.75, a[1] + (b[1] - a[1]) * 0.75]);
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

// Turn angle (degrees away from straight) at interior vertex i.
function turnDeg(a, b, c) {
  const mLat = 111320, mLon = mLat * Math.cos(b[1] * Math.PI / 180);
  const v1x = (b[0] - a[0]) * mLon, v1y = (b[1] - a[1]) * mLat;
  const v2x = (c[0] - b[0]) * mLon, v2y = (c[1] - b[1]) * mLat;
  const d1 = Math.hypot(v1x, v1y), d2 = Math.hypot(v2x, v2y);
  if (d1 < 1e-6 || d2 < 1e-6) return 0;
  let cos = (v1x * v2x + v1y * v2y) / (d1 * d2);
  cos = Math.max(-1, Math.min(1, cos));
  return Math.acos(cos) * 180 / Math.PI;
}

// Build byRoute exactly like the client: slot = lane among visible routes on
// that edge, centered on 0 (here ALL routes are "visible").
const byRoute = new Map();
for (const edge of data.edges) {
  const routeIds = edge.routeIds;
  const n = routeIds.length;
  const center = (n - 1) / 2;
  routeIds.forEach((rid, i) => {
    if (onlyRoute && String(rid) !== onlyRoute) return;
    if (!byRoute.has(rid)) byRoute.set(rid, []);
    byRoute.get(rid).push({ coords: edge.coords, slot: i - center });
  });
}

const rows = [];
for (const [rid, edges] of byRoute) {
  const runs = chainRouteEdges(edges);
  let frags = 0, kinks = 0, worstKink = 0, totalLen = 0;
  const slots = new Set();
  for (const run of runs) {
    const len = polylineLenM(run.coords);
    totalLen += len;
    if (len < FRAG_M) frags++;
    slots.add(run.slot);
    const sm = smoothPolyline(run.coords);
    for (let i = 1; i < sm.length - 1; i++) {
      const t = turnDeg(sm[i - 1], sm[i], sm[i + 1]);
      if (t > KINK_DEG) kinks++;
      if (t > worstKink) worstKink = t;
    }
  }
  rows.push({ rid, runs: runs.length, frags, slots: slots.size, kinks, worstKink, km: totalLen / 1000 });
}

rows.sort((a, b) => b.runs - a.runs);
console.log(`\nRibbon geometry report — ${rows.length} route(s), from data/route-edges.json`);
console.log(`(runs=separate polylines, frag=<${FRAG_M}m stub, kink=turn>${KINK_DEG}° after smoothing)\n`);
console.log('route    runs  frags  slots  kinks  worstTurn   length');
console.log('─'.repeat(62));
for (const r of rows) {
  const flag = (r.runs > 8 || r.frags > 3 || r.kinks > 0) ? '  ⚠' : '';
  console.log(
    `${String(r.rid).padEnd(7)} ${String(r.runs).padStart(5)} ${String(r.frags).padStart(6)} ` +
    `${String(r.slots).padStart(6)} ${String(r.kinks).padStart(6)} ${(r.worstKink).toFixed(0).padStart(9)}° ` +
    `${r.km.toFixed(1).padStart(7)}km${flag}`
  );
}
const tot = rows.reduce((a, r) => ({ runs: a.runs + r.runs, frags: a.frags + r.frags, kinks: a.kinks + r.kinks }), { runs: 0, frags: 0, kinks: 0 });
console.log('─'.repeat(62));
console.log(`TOTAL   ${String(tot.runs).padStart(5)} ${String(tot.frags).padStart(6)}        ${String(tot.kinks).padStart(6)}`);
console.log(`\n${rows.filter(r => r.runs > 8 || r.frags > 3 || r.kinks > 0).length} route(s) flagged for cleanup.`);
