'use strict';
/**
 * Builds the data for "ribbon" route rendering: for every real road-graph
 * edge (a junction-to-junction slice of a real OSM way — road-graph.js) that
 * ANY route travels, record its own verbatim coordinates once, plus which
 * routes travel it. The client draws each edge as N parallel offset stripes
 * (N = how many routes share it) using ONLY this edge's real coordinates —
 * never a synthesized point — so a road used by 3 routes shows 3 thin
 * stripes tight together (like a printed transit map's "ribbon" convention),
 * and a solo road shows one stripe sized the same as if it were a ribbon of
 * one. This replaces both the old GeoJSON-overlay renderer (which could
 * drift from the road) and the basemap-recolor renderer (which can only
 * show ONE route's color per road) — same underlying real-road matching
 * (road-graph.js / snap-routes-to-roads.js's matchedEdgeSequence), reused
 * here for its per-edge precision instead of concatenated into one polyline.
 *
 * Usage: node scripts/build-route-edges.js <path-to-extracted-gtfs-dir>
 * Writes data/route-edges.json:
 *   { edges: [ { id, coords: [[lon,lat],...], routeIds: [...] }, ... ] }
 */
const fs = require('fs');
const path = require('path');
const { loadRoadGraph, buildEdgeIndex } = require('../road-graph.js');
const { loadRawGtfsShapesForCli, connectedEdgePathForCli } = require('./snap-routes-to-roads.js');

const ROOT = path.join(__dirname, '..');

async function main() {
  console.log('Loading road graph…');
  const graph = loadRoadGraph();
  console.log(`  ${graph.nodes.size} nodes, ${graph.edges.length} edges`);
  const edgeIndex = buildEdgeIndex(graph);

  const gtfsDir = process.argv[2];
  if (!gtfsDir) {
    console.error('Usage: node scripts/build-route-edges.js <path-to-extracted-gtfs-dir>');
    process.exit(1);
  }
  const sourceShapes = loadRawGtfsShapesForCli(gtfsDir);
  console.log(`  ${Object.keys(sourceShapes).length} source patterns`);

  // edgeIdx -> Set(route_id) — which routes travel this exact real road edge.
  const edgeRoutes = new Map();
  let processed = 0;
  for (const key of Object.keys(sourceShapes)) {
    const entry = sourceShapes[key];
    if (!entry.coords || entry.coords.length < 2 || entry.route_id == null) continue;
    let edgeSeq;
    try {
      edgeSeq = connectedEdgePathForCli(graph, edgeIndex, entry.coords);
    } catch (e) {
      console.error(`  pattern ${key} failed: ${e.message}`);
      continue;
    }
    for (const edgeIdx of edgeSeq) {
      if (edgeIdx == null) continue;
      if (!edgeRoutes.has(edgeIdx)) edgeRoutes.set(edgeIdx, new Set());
      edgeRoutes.get(edgeIdx).add(entry.route_id);
    }
    processed++;
  }
  console.log(`Processed ${processed} patterns, ${edgeRoutes.size} distinct road edges used by at least one route`);

  // Smooth short-edge lane-count transitions. A block that's genuinely just
  // 15-20m long (a real, common OSM segment length at busy intersections)
  // sitting between two longer segments carrying MORE routes shows a visible
  // "jog" in the ribbon at each end — the rendered lane count snaps from N to
  // fewer and back to N over a span barely wider than the line itself, which
  // reads as a broken/dashed line even though the underlying road is one
  // continuous street. Fix: a short edge (<30m) inherits the UNION of the
  // route sets on its immediate neighbor edges (those sharing a graph node),
  // when that union is a superset of what it already has — so the ribbon's
  // lane count stays visually consistent across a short connector instead of
  // narrowing and widening within the space of one rendered dash. This adds
  // route membership only (never new coordinates) and only where the short
  // edge's neighbors already independently carry those routes, so it can't
  // claim a route never actually used this block.
  function distM(a, b) {
    const R = 6371000;
    const mPerDegLat = 111320, mPerDegLon = mPerDegLat * Math.cos(a[1] * Math.PI / 180);
    return Math.hypot((b[0]-a[0])*mPerDegLon, (b[1]-a[1])*mPerDegLat);
  }
  function edgeLengthM(e) {
    let len = 0;
    for (let i = 1; i < e.coords.length; i++) len += distM(e.coords[i-1], e.coords[i]);
    return len;
  }
  const SHORT_EDGE_M = 30;
  for (const [edgeIdx, routeIdSet] of edgeRoutes) {
    const e = graph.edges[edgeIdx];
    if (edgeLengthM(e) >= SHORT_EDGE_M) continue;
    const neighborUnion = new Set();
    for (const node of [e.a, e.b]) {
      const n = graph.nodes.get(node);
      if (!n) continue;
      for (const neighborIdx of n.edges) {
        if (neighborIdx === edgeIdx) continue;
        const neighborRoutes = edgeRoutes.get(neighborIdx);
        if (neighborRoutes) for (const rid of neighborRoutes) neighborUnion.add(rid);
      }
    }
    // Only absorb if BOTH ends have a neighbor with route data and the union
    // is strictly larger — a short edge with no route-carrying neighbors (a
    // genuine isolated case) is left as-is rather than guessed at.
    if (neighborUnion.size > routeIdSet.size) {
      for (const rid of neighborUnion) routeIdSet.add(rid);
    }
  }

  const edges = [];
  for (const [edgeIdx, routeIdSet] of edgeRoutes) {
    const e = graph.edges[edgeIdx];
    edges.push({
      id: edgeIdx,
      coords: e.coords,
      routeIds: [...routeIdSet].sort((a, b) => a - b),
    });
  }

  fs.writeFileSync(path.join(ROOT, 'data/route-edges.json'), JSON.stringify({ edges }));
  const sizeKB = fs.statSync(path.join(ROOT, 'data/route-edges.json')).size / 1024;
  console.log(`Wrote data/route-edges.json (${edges.length} edges, ${sizeKB.toFixed(0)} KB)`);
}

main().catch(e => { console.error(e); process.exit(1); });
