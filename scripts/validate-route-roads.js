// Validates every GTFS route shape against real OSM road geometry (vendored
// locally in data/osm/bigisland-roads.json — see scripts/build-osm-roads.js).
// Flags any point that drifts more than THRESHOLD_M from the nearest real road,
// so route-snapping regressions can be caught without eyeballing screenshots.
//   node scripts/validate-route-roads.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const roads = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/osm/bigisland-roads.json')));
// Prefer the road-snapped output (every point is drawn from real OSM road
// geometry by construction — see snap-routes-to-roads.js) when present; falls
// back to the older Valhalla-matched file otherwise.
const SNAPPED_PATH = path.join(ROOT, 'data/route-shapes-road-snapped.json');
const useSnapped = fs.existsSync(SNAPPED_PATH);
const routeData = JSON.parse(fs.readFileSync(useSnapped ? SNAPPED_PATH : path.join(ROOT, 'data/route-shapes-matched.json')));
console.log('validating against:', useSnapped ? 'route-shapes-road-snapped.json (multi-segment)' : 'route-shapes-matched.json (single shape)');

function decode(str, factor = 1e5) {
  let index = 0, lat = 0, lng = 0; const coords = [];
  while (index < str.length) {
    let b, shift = 0, result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coords.push([lng / factor, lat / factor]); // [lon, lat]
  }
  return coords;
}
function distM(a, b) {
  const R = 6371000;
  const phi1=a[1]*Math.PI/180, phi2=b[1]*Math.PI/180;
  const dphi=(b[1]-a[1])*Math.PI/180, dlam=(b[0]-a[0])*Math.PI/180;
  const h = Math.sin(dphi/2)**2 + Math.cos(phi1)*Math.cos(phi2)*Math.sin(dlam/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));
}
// distance from point P to segment AB, in meters (equirectangular approx, fine at this scale)
function distToSegment(p, a, b) {
  const latRef = p[1] * Math.PI/180;
  const mPerDegLon = 111320 * Math.cos(latRef);
  const mPerDegLat = 111320;
  const px = p[0]*mPerDegLon, py = p[1]*mPerDegLat;
  const ax = a[0]*mPerDegLon, ay = a[1]*mPerDegLat;
  const bx = b[0]*mPerDegLon, by = b[1]*mPerDegLat;
  const dx = bx-ax, dy = by-ay;
  const len2 = dx*dx+dy*dy;
  let t = len2 > 0 ? ((px-ax)*dx + (py-ay)*dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t*dx, cy = ay + t*dy;
  return Math.hypot(px-cx, py-cy);
}

// Spatial grid index of road segments for fast nearest-lookup (~110m cells)
const CELL_DEG = 0.001; // ~111m
const roadGrid = {};
function cellKey(lon, lat) { return `${Math.round(lat/CELL_DEG)},${Math.round(lon/CELL_DEG)}`; }
let segCount = 0;
for (const way of roads) {
  for (let i = 0; i < way.coords.length - 1; i++) {
    const a = way.coords[i], b = way.coords[i+1];
    const seg = { a, b, name: way.name, hw: way.hw };
    // register in cells covering both endpoints (+ neighbors for long segments handled via the 3x3 lookup later)
    for (const pt of [a, b]) {
      const k = cellKey(pt[0], pt[1]);
      (roadGrid[k] = roadGrid[k] || []).push(seg);
    }
    segCount++;
  }
}
console.log('road segments indexed:', segCount, 'grid cells:', Object.keys(roadGrid).length);

function nearestRoadDist(pt) {
  const latCell = Math.round(pt[1]/CELL_DEG), lonCell = Math.round(pt[0]/CELL_DEG);
  let best = Infinity, bestName = null;
  const seen = new Set();
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const k = `${latCell+dy},${lonCell+dx}`;
    const segs = roadGrid[k];
    if (!segs) continue;
    for (const seg of segs) {
      if (seen.has(seg)) continue;
      seen.add(seg);
      const d = distToSegment(pt, seg.a, seg.b);
      if (d < best) { best = d; bestName = seg.name; }
    }
  }
  return { dist: best, name: bestName };
}

// Validate every route's longest pattern. The snapped format stores a route as
// several segment polylines (real gaps are kept honest, not bridged) — flatten
// them into one coordinate list for sampling purposes.
function patternCoords(e) {
  if (e.segments) {
    let all = [];
    for (const seg of e.segments) { try { all = all.concat(decode(seg)); } catch {} }
    return all;
  }
  try { return decode(e.shape); } catch { return []; }
}

const routeLongest = {};
for (const key of Object.keys(routeData)) {
  const e = routeData[key];
  const coords = patternCoords(e);
  if (!coords.length) continue;
  if (!routeLongest[e.route_id] || coords.length > routeLongest[e.route_id].length) {
    routeLongest[e.route_id] = coords;
  }
}

const THRESHOLD_M = 25; // a road-snapped point should be within ~25m of a real road centerline
const report = [];
for (const [rid, coords] of Object.entries(routeLongest)) {
  let offRoadPts = 0, maxDist = 0, worstPt = null;
  const sampleEvery = Math.max(1, Math.floor(coords.length / 2000)); // cap work for very dense shapes
  let checked = 0;
  for (let i = 0; i < coords.length; i += sampleEvery) {
    const { dist } = nearestRoadDist(coords[i]);
    checked++;
    if (dist > THRESHOLD_M) {
      offRoadPts++;
      if (dist > maxDist) { maxDist = dist; worstPt = coords[i]; }
    }
  }
  const pct = (offRoadPts/checked*100);
  report.push({ rid, checked, offRoadPts, pct: +pct.toFixed(1), maxDist: Math.round(maxDist), worstPt });
}
report.sort((a,b) => b.pct - a.pct);
console.log('\n=== Route road-alignment report (>25m from nearest OSM road = flagged) ===');
for (const r of report) {
  console.log(`route ${r.rid}: ${r.offRoadPts}/${r.checked} pts off-road (${r.pct}%), worst=${r.maxDist}m at ${r.worstPt ? r.worstPt[1].toFixed(5)+','+r.worstPt[0].toFixed(5) : 'n/a'}`);
}
fs.writeFileSync(path.join(ROOT, 'data/osm/road-alignment-report.json'), JSON.stringify(report, null, 1));
