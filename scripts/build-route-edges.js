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
const { loadRawGtfsShapesForCli, matchedEdgeSequenceForCli } = require('./snap-routes-to-roads.js');

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
      edgeSeq = matchedEdgeSequenceForCli(graph, edgeIndex, entry.coords);
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
