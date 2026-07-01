'use strict';
/**
 * Fetch FULL-RESOLUTION Big Island road geometry from the OSM Overpass API into
 * data/osm/bigisland-roads.json (same shape build-osm-roads.js produced from a
 * PBF: [{ id, hw, name, coords:[[lon,lat],...] }], but with EVERY real shape
 * vertex, not a simplified subset).
 *
 * Why: the previous roads file had coarse geometry (long straight chords between
 * sparse points), so route ribbons drawn from it cut corners — including big
 * arcs across Hilo Bay where a chord skipped the road's real curve. Real per-
 * vertex geometry (Overpass `out geom`) means a drawn road segment can never
 * leave the actual road. Roads are ground truth; we stop guessing where they are.
 *
 * Usage: node scripts/fetch-osm-roads-overpass.js
 * (No PBF / no pbf2json binary needed.)
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const BBOX = { latMin: 18.85, latMax: 20.35, lonMin: -156.10, lonMax: -154.75 };

// Drivable/route-relevant highway classes only (matches what buses use; skips
// footways/steps/etc. that bloat the graph and never carry a route).
const HW = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|road|busway';

const QUERY = `[out:json][timeout:180];
way["highway"~"^(${HW})$"](${BBOX.latMin},${BBOX.lonMin},${BBOX.latMax},${BBOX.lonMax});
out geom;`;

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
        'User-Agent': 'hele-on-tracker/1.0 (road geometry extract)',
      },
    }, (r) => {
      let buf = '';
      r.on('data', d => buf += d);
      r.on('end', () => r.statusCode === 200 ? resolve(buf) : reject(new Error(`HTTP ${r.statusCode}: ${buf.slice(0, 300)}`)));
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

async function main() {
  let raw = null, lastErr = null;
  for (const ep of ENDPOINTS) {
    try { console.log(`Querying Overpass roads: ${ep} …`); raw = await post(ep, QUERY); break; }
    catch (e) { console.error(`  failed: ${e.message}`); lastErr = e; }
  }
  if (!raw) throw lastErr || new Error('all Overpass endpoints failed');

  const parsed = JSON.parse(raw);
  const ways = [];
  for (const el of parsed.elements || []) {
    if (el.type !== 'way' || !Array.isArray(el.geometry) || el.geometry.length < 2) continue;
    const coords = el.geometry.map(g => [g.lon, g.lat]);
    ways.push({ id: el.id, hw: el.tags && el.tags.highway, name: (el.tags && el.tags.name) || null, coords });
  }

  // Sanity: report the longest single segment — should now be small (real roads
  // have vertices every few metres through curves).
  let maxSeg = 0;
  const distM = (a, b) => { const mLat = 111320, mLon = mLat * Math.cos(a[1]*Math.PI/180); return Math.hypot((b[0]-a[0])*mLon, (b[1]-a[1])*mLat); };
  for (const w of ways) for (let i = 1; i < w.coords.length; i++) maxSeg = Math.max(maxSeg, distM(w.coords[i-1], w.coords[i]));

  const outPath = path.join(ROOT, 'data/osm/bigisland-roads.json');
  fs.writeFileSync(outPath, JSON.stringify(ways));
  console.log(`Wrote ${ways.length} full-geometry roads -> ${outPath}`);
  console.log(`  size: ${(fs.statSync(outPath).size / 1024 / 1024).toFixed(1)} MB, longest segment: ${Math.round(maxSeg)}m`);
}

main().catch(e => { console.error(e); process.exit(1); });
