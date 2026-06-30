'use strict';
/**
 * Snaps every GTFS route shape onto the real local road network (road-graph.js +
 * data/osm/bigisland-roads.json), producing route lines that are LITERALLY composed
 * of real road segments — not independently-traced polylines that can diverge from
 * the basemap. This replaces the Valhalla-based map-matching pipeline (map-match.js)
 * as the primary source of vendored route geometry: same local data already used by
 * scripts/validate-route-roads.js, no external service dependency, deterministic.
 *
 * Algorithm per shape:
 *   1. Downsample the raw shape to ~40m spacing (keeps the snap-point count sane).
 *   2. Snap each point onto the nearest road-graph edge within a search radius.
 *      Points that don't snap (radius exceeded — e.g. a parking lot, a gap in OSM
 *      coverage) are dropped; consecutive runs of unsnapped points break the path
 *      into separate segments rather than bridging with a straight line.
 *   3. Between consecutive snapped points, walk the shortest path along the graph
 *      (bounded search radius) and emit its real edge geometry. If no path is found
 *      within range (a genuine gap, or the points snapped to disconnected
 *      components), that gap is skipped rather than bridged — same "honest gap over
 *      a wrong line" principle as map-match.js's quality gate.
 *   4. The final coordinate list is the concatenation of real edge geometry only:
 *      every point in the output came from an actual OSM road way.
 *
 * Usage: node scripts/snap-routes-to-roads.js
 * Writes data/route-shapes-road-snapped.json: pattern_id -> { route_id, shape (encoded) }
 */
const fs = require('fs');
const path = require('path');
const {
  loadRoadGraph, buildEdgeIndex, nearestPointOnGraph, shortestPath, edgeCoordsFrom,
} = require('../road-graph.js');

const ROOT = path.join(__dirname, '..');

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
function encode(coords, factor = 1e5) {
  let last = [0, 0], out = '';
  const enc = v => { v = v < 0 ? ~(v << 1) : (v << 1); let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const [lon, lat] of coords) {
    const latI = Math.round(lat * factor), lonI = Math.round(lon * factor);
    out += enc(latI - last[0]) + enc(lonI - last[1]);
    last = [latI, lonI];
  }
  return out;
}
function distM(a, b) {
  const R = 6371000;
  const phi1 = a[1]*Math.PI/180, phi2 = b[1]*Math.PI/180;
  const dphi = (b[1]-a[1])*Math.PI/180, dlam = (b[0]-a[0])*Math.PI/180;
  const h = Math.sin(dphi/2)**2 + Math.cos(phi1)*Math.cos(phi2)*Math.sin(dlam/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));
}

function downsample(coords, spacingM) {
  if (coords.length < 2) return coords;
  const out = [coords[0]];
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    acc += distM(coords[i-1], coords[i]);
    if (acc >= spacingM) { out.push(coords[i]); acc = 0; }
  }
  if (out[out.length-1] !== coords[coords.length-1]) out.push(coords[coords.length-1]);
  return out;
}

const SNAP_RADIUS_M = 40;       // tight radius first — keeps urban snaps precise
const SNAP_RADIUS_FALLBACK_M = 150; // retried only for points the tight pass missed —
                                     // rural highways have sparser OSM node spacing and
                                     // sparser GTFS shape points, so a 40m radius alone
                                     // fragmented long routes (5745, 5600) into 30+ broken
                                     // segments even though the road was right there, just
                                     // slightly further from the (also sparse) shape point.
const PATH_SEARCH_MAX_M = 2500;  // how far Dijkstra will search to connect two consecutive snaps

function snapShapeToRoads(graph, edgeIndex, rawCoords) {
  const pts = downsample(rawCoords, 40);
  const snaps = pts.map(p =>
    nearestPointOnGraph(graph, edgeIndex, p, SNAP_RADIUS_M) ||
    nearestPointOnGraph(graph, edgeIndex, p, SNAP_RADIUS_FALLBACK_M));

  const segments = []; // each: array of [lon,lat]
  let current = [];

  for (let i = 0; i < snaps.length; i++) {
    const s = snaps[i];
    if (!s) {
      if (current.length > 1) segments.push(current);
      current = [];
      continue;
    }
    if (!current.length) { current.push(s.point); continue; }

    const prevSnap = snaps[i - 1];
    if (!prevSnap) { current.push(s.point); continue; }

    if (s.edgeIdx === prevSnap.edgeIdx) {
      // Same edge — just extend toward the new point along it (already a real road).
      current.push(s.point);
      continue;
    }

    // Different edges — connect via the real road graph between their nearer nodes.
    const e1 = graph.edges[prevSnap.edgeIdx], e2 = graph.edges[s.edgeIdx];
    // Try all 4 node-pair combinations, take the shortest real path.
    let bestPath = null, bestNodes = null, bestLen = Infinity;
    for (const n1 of [e1.a, e1.b]) {
      for (const n2 of [e2.a, e2.b]) {
        const p = shortestPath(graph, n1, n2, PATH_SEARCH_MAX_M);
        if (p) {
          const len = p.reduce((s, ei) => s + graph.edges[ei].lengthM, 0);
          if (len < bestLen) { bestLen = len; bestPath = p; bestNodes = [n1, n2]; }
        }
      }
    }
    if (!bestPath) {
      // No connection found within range — honest gap, start a new segment.
      if (current.length > 1) segments.push(current);
      current = [s.point];
      continue;
    }
    let cursor = bestNodes[0];
    for (const ei of bestPath) {
      const coords = edgeCoordsFrom(graph, ei, cursor);
      current.push(...coords.slice(1)); // skip first point — already have it (or it's the snap point)
      cursor = graph.edges[ei].a === cursor ? graph.edges[ei].b : graph.edges[ei].a;
    }
    current.push(s.point);
  }
  if (current.length > 1) segments.push(current);
  return segments;
}

module.exports = { snapShapeToRoads, decode, encode, downsample };

async function loadSourceShapes() {
  // Prefer the live server's /api/shapes (every pattern the agency currently
  // serves, including ones added after the vendored file was last built —
  // exactly the gap that left newer patterns stuck unsnapped indefinitely).
  // Falls back to the vendored file (already-matched geometry) if no server
  // arg is given, so this still works offline / in CI.
  const serverUrl = process.argv[2]; // e.g. https://bus-tracker-a36o.onrender.com
  if (serverUrl) {
    console.log(`Fetching live shapes from ${serverUrl}/api/shapes …`);
    const https = require('https'), http = require('http');
    const lib = serverUrl.startsWith('https') ? https : http;
    const body = await new Promise((resolve, reject) => {
      lib.get(`${serverUrl}/api/shapes`, res => {
        let b = ''; res.on('data', d => b += d); res.on('end', () => resolve(b));
      }).on('error', reject);
    });
    const shapes = JSON.parse(body);
    const out = {};
    for (const s of shapes) out[String(s.pattern_id)] = { route_id: s.route_id, shape: s.shape };
    return out;
  }
  console.log('No server URL given — using data/route-shapes-matched.json as source.');
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'data/route-shapes-matched.json')));
}

async function main() {
  console.log('Loading road graph…');
  const graph = loadRoadGraph();
  console.log(`  ${graph.nodes.size} nodes, ${graph.edges.length} edges`);
  const edgeIndex = buildEdgeIndex(graph);

  const sourceShapes = await loadSourceShapes();
  console.log(`  ${Object.keys(sourceShapes).length} source patterns`);

  const out = {};
  let snappedCount = 0, failedCount = 0;
  for (const key of Object.keys(sourceShapes)) {
    const entry = sourceShapes[key];
    if (!entry.shape) continue;
    const rawCoords = decode(entry.shape);
    if (rawCoords.length < 2) continue;
    const segments = snapShapeToRoads(graph, edgeIndex, rawCoords);
    const totalPts = segments.reduce((s, seg) => s + seg.length, 0);
    if (totalPts < 2) { failedCount++; continue; }
    // Encode as a single shape by concatenating segments with a tiny gap marker
    // removed — store segments separately so the renderer can draw each as its
    // own LineString (a MultiLineString) instead of bridging real gaps.
    out[key] = {
      route_id: entry.route_id,
      segments: segments.map(seg => encode(seg)),
    };
    snappedCount++;
    if (snappedCount % 20 === 0) console.log(`  ...${snappedCount} patterns snapped`);
  }
  console.log(`Snapped ${snappedCount} patterns (${failedCount} produced no usable road path)`);
  fs.writeFileSync(path.join(ROOT, 'data/route-shapes-road-snapped.json'), JSON.stringify(out));
  console.log('Wrote data/route-shapes-road-snapped.json');
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}
