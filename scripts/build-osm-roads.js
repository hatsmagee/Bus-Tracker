// One-time build step: extract Big Island road geometry from an OSM PBF extract
// into data/osm/bigisland-roads.json, a small local "ground truth" road network
// used by scripts/validate-route-roads.js to check GTFS route shapes actually
// follow real roads — no live map/DevTools needed.
//
// Usage:
//   curl -L -o /tmp/hawaii-latest.osm.pbf \
//     https://download.geofabrik.de/north-america/us/hawaii-latest.osm.pbf
//   node scripts/build-osm-roads.js /tmp/hawaii-latest.osm.pbf
//
// Requires the `pbf2json` package (npm install --no-save pbf2json) and its
// prebuilt Go binary — no native compilation needed.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const pbfPath = process.argv[2];
if (!pbfPath) {
  console.error('Usage: node scripts/build-osm-roads.js <path-to-hawaii-latest.osm.pbf>');
  process.exit(1);
}

// Big Island bounding box (generous margin beyond the service area)
const BBOX = { latMin: 18.85, latMax: 20.35, lonMin: -156.10, lonMax: -154.75 };
const SKIP_HIGHWAY_TYPES = new Set([
  'proposed', 'construction', 'razed', 'abandoned', 'platform', 'rest_area', 'services', 'elevator',
]);

async function main() {
  const binDir = path.join(ROOT, 'node_modules/pbf2json/build');
  const bin = {
    linux: 'pbf2json.linux-x64',
    darwin: 'pbf2json.darwin-x64',
  }[process.platform];
  if (!bin) throw new Error(`No prebuilt pbf2json binary for platform ${process.platform}`);
  const binPath = path.join(binDir, bin);
  fs.chmodSync(binPath, 0o755);

  const jsonlPath = path.join(ROOT, 'data/osm/.tmp-highways.jsonl');
  console.log('Extracting highway ways from PBF (this takes ~10s)...');
  execFileSync(binPath, ['-tags=highway', '--waynodes=true', pbfPath], {
    stdio: ['ignore', fs.openSync(jsonlPath, 'w'), 'inherit'],
    maxBuffer: Infinity,
  });

  console.log('Filtering to Big Island roads...');
  const rl = readline.createInterface({ input: fs.createReadStream(jsonlPath) });
  const ways = [];
  let total = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'way' || !o.nodes || o.nodes.length < 2) continue;
    total++;
    const hw = o.tags && o.tags.highway;
    if (!hw || SKIP_HIGHWAY_TYPES.has(hw)) continue;
    const c = o.centroid;
    if (!c) continue;
    const lat = parseFloat(c.lat), lon = parseFloat(c.lon);
    if (lat < BBOX.latMin || lat > BBOX.latMax || lon < BBOX.lonMin || lon > BBOX.lonMax) continue;
    const coords = o.nodes.map(n => [parseFloat(n.lon), parseFloat(n.lat)]);
    ways.push({ id: o.id, hw, name: o.tags.name || null, coords });
  }
  fs.unlinkSync(jsonlPath);

  const outPath = path.join(ROOT, 'data/osm/bigisland-roads.json');
  fs.writeFileSync(outPath, JSON.stringify(ways));
  console.log(`Scanned ${total} ways, kept ${ways.length} Big Island roads -> ${outPath}`);
  console.log(`Output size: ${(fs.statSync(outPath).size / 1024).toFixed(0)} KB`);
}

main().catch(e => { console.error(e); process.exit(1); });
