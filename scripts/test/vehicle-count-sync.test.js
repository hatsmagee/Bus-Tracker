'use strict';
// Every surface that shows "how many buses" must show the SAME number: the
// header badge, the island tiles, the sidebar list and the map markers.
//
// They used to disagree. The island tile hardcoded `!isStale(v)` while the
// header honoured the Last-known-shown toggle, so a fleet of stale-but-assigned
// buses rendered as "2 buses · Big Island" next to a Big Island tile reading 0.
// Three of the four call sites also re-filtered on v.unassigned, which
// hasValidRoute already rejects, and the map markers didn't filter it at all.
//
// These tests extract the real predicates from the client so they can't drift.
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../lib/paths');

function loadImpl() {
  const html = fs.readFileSync(path.join(ROOT, 'heleon-tracker.html'), 'utf8');
  const grab = (name) => {
    const i = html.search(new RegExp('function ' + name + '\\s*\\('));
    if (i < 0) throw new Error(`${name}() not found in heleon-tracker.html — did it move or get renamed?`);
    let d = 0, end = -1, inS = null;
    const j = html.indexOf('{', i);
    for (let k = j; k < html.length; k++) {
      const c = html[k], p = html[k - 1];
      if (inS) { if (c === inS && p !== '\\') inS = null; continue; }
      if (c === "'" || c === '"' || c === '`') { inS = c; continue; }
      if (c === '{') d++;
      else if (c === '}') { d--; if (d === 0) { end = k + 1; break; } }
    }
    return html.slice(i, end);
  };
  const m = html.match(/const STALE_THRESHOLD\s*=\s*([\d.]+)/);
  if (!m) throw new Error('STALE_THRESHOLD not found');
  return new Function([
    'let showStale = false, allVehicles = [];',
    `const STALE_THRESHOLD = ${m[1]};`,
    grab('getAgeMinutes'),
    'function isStale(v){ return getAgeMinutes(v) >= STALE_THRESHOLD; }',
    grab('hasValidRoute'),
    grab('isPlottableVehicle'),
    grab('countableVehicles'),
    `return {
       threshold: STALE_THRESHOLD,
       set(v, s) { allVehicles = v; showStale = s; },
       header: () => countableVehicles(allVehicles).length,
       tile: (cache) => countableVehicles(cache).length,
       list: () => countableVehicles(allVehicles).length,
       markers: (isl) => countableVehicles(allVehicles).filter(v => (v.island || isl) === isl).length,
     };`,
  ].join('\n'))();
}

const impl = loadImpl();
const T = impl.threshold;
// Ages are relative to now; getAgeMinutes reads lastUpdated/vehicleTs.
const bus = (over, extra) => Object.assign({
  id: Math.random(), island: 'big-island', lat: 19.7, lon: -155.1,
  routeId: 5600, routeShort: '10', unassigned: false,
  lastUpdated: Date.now() - over * 60000,
}, extra || {});

function allAgree(vehicles, showStale) {
  impl.set(vehicles, showStale);
  const h = impl.header(), t = impl.tile(vehicles), l = impl.list(), m = impl.markers('big-island');
  if (!(h === t && t === l && l === m)) {
    throw new Error(`counts disagree (showStale=${showStale}): header=${h} tile=${t} list=${l} markers=${m}`);
  }
  return h;
}

module.exports = {
  'all surfaces agree when every bus is stale (the reported bug)': () => {
    // 2 assigned but stale + 3 unassigned — exactly the Big Island payload that
    // rendered as "2 buses" beside a tile showing 0.
    const fleet = [
      bus(T + 100), bus(T + 200),
      bus(T + 300, { routeId: null, routeShort: '—', unassigned: true }),
      bus(T + 400, { routeId: null, routeShort: '—', unassigned: true }),
      bus(T + 500, { routeId: null, routeShort: '—', unassigned: true }),
    ];
    if (allAgree(fleet, true) !== 2) throw new Error('expected 2 with stale shown');
    if (allAgree(fleet, false) !== 0) throw new Error('expected 0 with stale hidden');
  },

  'all surfaces agree for a healthy live fleet': () => {
    const fleet = [bus(1), bus(2), bus(3)];
    if (allAgree(fleet, false) !== 3) throw new Error('expected 3 live');
    if (allAgree(fleet, true) !== 3) throw new Error('expected 3 with stale shown');
  },

  'unassigned units never count on any surface': () => {
    const fleet = [
      bus(1),
      bus(1, { unassigned: true, routeId: null, routeShort: '—' }),
      bus(1, { routeId: null, routeShort: 'null' }),
    ];
    if (allAgree(fleet, true) !== 1) throw new Error('unassigned/route-less units leaked into a count');
  },

  'buses without coordinates never count (they cannot be plotted)': () => {
    const fleet = [bus(1), bus(1, { lat: null, lon: null }), bus(1, { lat: NaN, lon: NaN })];
    if (allAgree(fleet, true) !== 1) throw new Error('unplottable buses counted');
  },

  'empty fleet reports zero everywhere': () => {
    if (allAgree([], true) !== 0) throw new Error('non-zero for empty fleet');
    if (allAgree([], false) !== 0) throw new Error('non-zero for empty fleet');
  },

  'the stale toggle moves every surface together': () => {
    const fleet = [bus(1), bus(T + 50), bus(T + 60)];
    const shown = allAgree(fleet, true);   // 1 live + 2 stale
    const hidden = allAgree(fleet, false); // 1 live
    if (shown !== 3) throw new Error(`expected 3 with stale shown, got ${shown}`);
    if (hidden !== 1) throw new Error(`expected 1 with stale hidden, got ${hidden}`);
  },

  // The tests above prove the shared predicate is right. This one proves the
  // call sites actually USE it — the original bug was not a bad predicate but
  // four call sites each rolling their own filter. Without this check, someone
  // can reintroduce the exact reported bug and every behavioural test still
  // passes (verified: it did).
  'no surface rolls its own vehicle filter': () => {
    const html = fs.readFileSync(path.join(ROOT, 'heleon-tracker.html'), 'utf8');
    const lines = html.split('\n');
    // The two shared helpers legitimately apply the stale filter themselves;
    // everything between their braces is exempt.
    const exempt = new Set();
    for (const name of ['visibleVehicles', 'countableVehicles']) {
      const start = lines.findIndex(l => l.includes(`function ${name}(`));
      if (start < 0) throw new Error(`${name}() not found — did it move or get renamed?`);
      for (let i = start; i < lines.length; i++) { exempt.add(i); if (lines[i].startsWith('}')) break; }
    }
    const offenders = [];
    lines.forEach((line, i) => {
      if (exempt.has(i) || /^\s*(\/\/|\*)/.test(line)) return;
      // An ad-hoc filter feeding a COUNT or a render list is the bug; building a
      // set of "which buses just went stale" (for ghost transitions) is fine.
      const adHoc = /\.filter\(\s*v\s*=>[^)]*\bisStale\(/.test(line) ||
                    /\.filter\(\s*v\s*=>[^)]*!\s*v\.unassigned/.test(line);
      if (!adHoc) return;
      const isCount = /\.length|const\s+(visible|vcount|liveCount)\b/.test(line);
      if (isCount) offenders.push(`${i + 1}: ${line.trim()}`);
    });
    if (offenders.length) {
      throw new Error('vehicle counts must go through countableVehicles():\n  ' + offenders.join('\n  '));
    }
  },
};
