'use strict';
/**
 * Connectivity diagnostic for the route-ribbon layer.
 *
 * The ribbon layer (data/route-edges.json, built by build-route-edges.js) is
 * drawn straight from `matchedEdgeSequence` WITHOUT the gap-bridging that
 * colorRoadsForShape does. So wherever the matcher's ordered edge sequence has
 * a null (unsnapped sample) or two consecutive edges that don't share a graph
 * node, the ribbon shows a visible break. This script runs the SAME matcher
 * per route and reports, in plain numbers, whether each route's ribbon is one
 * connected chain and — if not — exactly where every break is (lat/lon you can
 * paste into the map).
 *
 * Usage: node scripts/diagnose-route-connectivity.js <path-to-extracted-gtfs-dir> [routeId]
 */
const path = require('path');
const { loadRoadGraph, buildEdgeIndex } = require('../road-graph.js');
const { matchedEdgeSequenceForCli, connectedEdgePathForCli, loadRawGtfsShapesForCli } = require('./snap-routes-to-roads.js');

// Which matcher to test: `node ... <gtfs> [routeId] --raw` for the old
// (unbridged) sequence, otherwise the new connected-path builder.
const USE_RAW = process.argv.includes('--raw');
const matcher = USE_RAW ? matchedEdgeSequenceForCli : connectedEdgePathForCli;

function distM(a, b) {
  const R = 6371000;
  const p1 = a[1] * Math.PI / 180, p2 = b[1] * Math.PI / 180;
  const dp = (b[1] - a[1]) * Math.PI / 180, dl = (b[0] - a[0]) * Math.PI / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function main() {
  const gtfsDir = process.argv[2];
  const onlyRoute = process.argv[3] && !process.argv[3].startsWith('--') ? String(process.argv[3]) : null;
  if (!gtfsDir) {
    console.error('Usage: node scripts/diagnose-route-connectivity.js <gtfs-dir> [routeId]');
    process.exit(1);
  }

  const graph = loadRoadGraph();
  const edgeIndex = buildEdgeIndex(graph);
  const shapes = loadRawGtfsShapesForCli(gtfsDir);

  // Group shapes by route_id (a route has several shapes/patterns).
  const byRoute = new Map();
  for (const key of Object.keys(shapes)) {
    const e = shapes[key];
    if (!e.coords || e.coords.length < 2 || e.route_id == null) continue;
    if (onlyRoute && String(e.route_id) !== onlyRoute) continue;
    if (!byRoute.has(e.route_id)) byRoute.set(e.route_id, []);
    byRoute.get(e.route_id).push({ key, coords: e.coords });
  }

  const routeIds = [...byRoute.keys()].sort((a, b) => a - b);
  console.log(`\nConnectivity report [${USE_RAW ? 'RAW matcher' : 'CONNECTED path builder'}] — ${routeIds.length} route(s)\n${'='.repeat(60)}`);

  const summary = [];
  for (const rid of routeIds) {
    const patterns = byRoute.get(rid);
    let totalEdges = 0, totalGaps = 0, totalBreaks = 0, totalShort = 0;
    const breakLocations = [];

    for (const pat of patterns) {
      const seq = matcher(graph, edgeIndex, pat.coords);
      totalEdges += seq.filter(x => x != null).length;

      let prevEdge = null;
      for (let i = 0; i < seq.length; i++) {
        const cur = seq[i];
        if (cur == null) { totalGaps++; prevEdge = null; continue; }
        const e = graph.edges[cur];
        if (prevEdge != null) {
          const p = graph.edges[prevEdge];
          // Connected iff they share a node.
          const touch = p.a === e.a || p.a === e.b || p.b === e.a || p.b === e.b;
          if (!touch) {
            totalBreaks++;
            const from = p.coords[p.coords.length - 1];
            const to = e.coords[0];
            const gapM = distM(from, to);
            if (gapM < 40) totalShort++;
            breakLocations.push({ pattern: pat.key, gapM: Math.round(gapM), at: to });
          }
        }
        prevEdge = cur;
      }
    }

    const connected = totalBreaks === 0 && totalGaps === 0;
    summary.push({ rid, totalEdges, totalGaps, totalBreaks, totalShort, connected });

    const flag = connected ? 'OK  connected' : `BROKEN  ${totalBreaks} breaks, ${totalGaps} gaps`;
    console.log(`\nroute ${rid}: ${totalEdges} edges — ${flag}`);
    if (!connected) {
      const bridgeable = breakLocations.filter(b => b.gapM < 40).length;
      console.log(`  ${bridgeable}/${breakLocations.length} breaks are <40m (bridgeable connector gaps)`);
      for (const b of breakLocations.slice(0, 12)) {
        console.log(`    break: ${b.gapM}m gap @ ${b.at[1].toFixed(5)},${b.at[0].toFixed(5)}  (pattern ${b.pattern})`);
      }
      if (breakLocations.length > 12) console.log(`    …and ${breakLocations.length - 12} more`);
    }
  }

  const broken = summary.filter(s => !s.connected);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`TOTALS: ${summary.length - broken.length}/${summary.length} routes fully connected`);
  console.log(`        ${broken.length} routes broken, ${summary.reduce((a, s) => a + s.totalBreaks, 0)} total breaks, ${summary.reduce((a, s) => a + s.totalGaps, 0)} total unsnapped gaps`);
  const totalShort = summary.reduce((a, s) => a + s.totalShort, 0);
  const totalBreaks = summary.reduce((a, s) => a + s.totalBreaks, 0);
  console.log(`        ${totalShort}/${totalBreaks} breaks are short (<40m) connector gaps that bridging would close`);
}

main();
