'use strict';
/**
 * Performance budget gate — the page must stay fast NO MATTER how much content
 * the agent publishes. This runs in the publish pre-push gate; a budget breach
 * blocks the publish the same way a failing unit test does.
 *
 * The budgets encode the page's structural performance rules:
 *  - The client renders sidebar lists lazily (only open categories) and map
 *    layers from shared sprites — so item COUNT is cheap, but only up to the
 *    caps below (map symbol layout + payload size are still linear).
 *  - New timers/animation loops and new map layers are the things that
 *    actually slow the page; their counts are pinned so a change that adds
 *    one is a deliberate, human-reviewed decision (raise the cap in the same
 *    commit and say why).
 */
const fs = require('fs');
const path = require('path');
const { ROOT, MAP_ITEMS_PATH } = require('./lib/paths');

const BUDGETS = {
  htmlBytes: 750 * 1024,        // heleon-tracker.html on disk (~540 KB today)
  mapItemsBytes: 2 * 1024 * 1024, // published catalog payload
  mapItemsTotal: 2500,          // total published items
  mapItemsPerCat: 500,          // per category — one runaway topic can't flood the map
  setIntervals: 40,             // page-lifetime timers in the client (~30 today)
  addLayers: 130,               // map.addLayer call sites (~115 today)
  domMarkerClasses: 12,         // custom DOM-marker families (wheels, turbines, …)
};

function checkPerfBudget() {
  const errors = [];
  const htmlPath = path.join(ROOT, 'heleon-tracker.html');
  const html = fs.readFileSync(htmlPath, 'utf8');

  if (Buffer.byteLength(html) > BUDGETS.htmlBytes) {
    errors.push(`heleon-tracker.html is ${Buffer.byteLength(html)} bytes (budget ${BUDGETS.htmlBytes})`);
  }
  const intervals = (html.match(/setInterval\s*\(/g) || []).length;
  if (intervals > BUDGETS.setIntervals) {
    errors.push(`client has ${intervals} setInterval sites (budget ${BUDGETS.setIntervals}) — reuse an existing poll or piggyback on SSE`);
  }
  const layers = (html.match(/map\.addLayer\s*\(/g) || []).length;
  if (layers > BUDGETS.addLayers) {
    errors.push(`client has ${layers} map.addLayer sites (budget ${BUDGETS.addLayers}) — new content should ride an existing generic layer`);
  }
  const markerFamilies = (html.match(/new maplibregl\.Marker\s*\(/g) || []).length;
  if (markerFamilies > BUDGETS.domMarkerClasses) {
    errors.push(`client creates DOM markers in ${markerFamilies} places (budget ${BUDGETS.domMarkerClasses}) — DOM markers are the most expensive marker type; use a symbol layer`);
  }

  try {
    const raw = fs.readFileSync(MAP_ITEMS_PATH);
    if (raw.length > BUDGETS.mapItemsBytes) {
      errors.push(`map-items.json is ${raw.length} bytes (budget ${BUDGETS.mapItemsBytes})`);
    }
    const doc = JSON.parse(raw.toString());
    const entries = Object.entries(doc.items || {});
    if (entries.length > BUDGETS.mapItemsTotal) {
      errors.push(`catalog has ${entries.length} items (budget ${BUDGETS.mapItemsTotal})`);
    }
    const perCat = {};
    for (const [, it] of entries) {
      const c = it.category || it.cat || it.kind || 'uncategorized';
      perCat[c] = (perCat[c] || 0) + 1;
    }
    for (const [c, n] of Object.entries(perCat)) {
      if (n > BUDGETS.mapItemsPerCat) errors.push(`category "${c}" has ${n} items (budget ${BUDGETS.mapItemsPerCat})`);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') errors.push(`map-items.json unreadable: ${e.message}`);
  }

  return { ok: errors.length === 0, errors, budgets: BUDGETS };
}

module.exports = { checkPerfBudget, BUDGETS };

if (require.main === module) {
  const r = checkPerfBudget();
  console.log(r.ok ? '[perf-budget] OK' : `[perf-budget] FAIL:\n - ${r.errors.join('\n - ')}`);
  process.exit(r.ok ? 0 : 1);
}
