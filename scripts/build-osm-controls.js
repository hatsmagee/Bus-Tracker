'use strict';
/**
 * Fetch traffic-control nodes (traffic signals, stop signs, and — as context —
 * pedestrian crossings & mini-roundabouts) for the Big Island from the OSM
 * Overpass API into data/osm/bigisland-controls.json.
 *
 * These are REAL road features (highway=traffic_signals / stop / crossing /
 * mini_roundabout nodes). The tracker draws them as a map layer and, more
 * importantly, attaches per-road-edge counts (see loadTrafficControls in the
 * server) so the ETA / neural-net features can know a segment has N signals +
 * M stop signs — which genuinely slows a bus down.
 *
 * Usage: node scripts/build-osm-controls.js
 * Writes: { generated, controls: [ { id, type, lon, lat } ] }
 *   type ∈ signal | stop | crossing | mini_roundabout
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
// Same generous Big Island bbox as build-osm-roads.js (S,W,N,E for Overpass).
const BBOX = { latMin: 18.85, latMax: 20.35, lonMin: -156.10, lonMax: -154.75 };

const QUERY = `[out:json][timeout:120];
(
  node["highway"="traffic_signals"](${BBOX.latMin},${BBOX.lonMin},${BBOX.latMax},${BBOX.lonMax});
  node["highway"="stop"](${BBOX.latMin},${BBOX.lonMin},${BBOX.latMax},${BBOX.lonMax});
  node["highway"="crossing"](${BBOX.latMin},${BBOX.lonMin},${BBOX.latMax},${BBOX.lonMax});
  node["highway"="mini_roundabout"](${BBOX.latMin},${BBOX.lonMin},${BBOX.latMax},${BBOX.lonMax});
);
out body;`;

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

function post(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = 'data=' + encodeURIComponent(body);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'hele-on-tracker/1.0 (traffic-control extract)',
      },
    }, (r) => {
      let buf = '';
      r.on('data', d => buf += d);
      r.on('end', () => r.statusCode === 200 ? resolve(buf) : reject(new Error(`HTTP ${r.statusCode}: ${buf.slice(0, 200)}`)));
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

const TYPE_MAP = { traffic_signals: 'signal', stop: 'stop', crossing: 'crossing', mini_roundabout: 'mini_roundabout' };

async function main() {
  let raw = null, lastErr = null;
  for (const ep of ENDPOINTS) {
    try {
      console.log(`Querying Overpass: ${ep} …`);
      raw = await post(ep, QUERY);
      break;
    } catch (e) { console.error(`  failed: ${e.message}`); lastErr = e; }
  }
  if (!raw) throw lastErr || new Error('all Overpass endpoints failed');

  const parsed = JSON.parse(raw);
  const controls = [];
  const counts = {};
  for (const el of parsed.elements || []) {
    if (el.type !== 'node' || el.lat == null || el.lon == null) continue;
    const hw = el.tags && el.tags.highway;
    const type = TYPE_MAP[hw];
    if (!type) continue;
    controls.push({ id: el.id, type, lon: el.lon, lat: el.lat });
    counts[type] = (counts[type] || 0) + 1;
  }

  const out = { generated: new Date().toISOString(), controls };
  const outPath = path.join(ROOT, 'data/osm/bigisland-controls.json');
  fs.writeFileSync(outPath, JSON.stringify(out));
  console.log(`Wrote ${controls.length} traffic-control nodes -> ${outPath}`);
  console.log(`  by type: ${JSON.stringify(counts)}`);
  console.log(`  size: ${(fs.statSync(outPath).size / 1024).toFixed(0)} KB`);
}

main().catch(e => { console.error(e); process.exit(1); });
