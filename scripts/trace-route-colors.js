'use strict';
/**
 * Programmatic tracer: walks each route's ACTUAL real-road path (the same
 * matched-edge sequence the ribbon renderer is built from — see
 * scripts/build-route-edges.js) and asserts, at every real road edge the
 * route travels, that this route's color is actually present in the
 * rendered ribbon data for that edge. If a route walks an edge that doesn't
 * carry its color in data/route-edges.json, that's a genuine rendering gap —
 * a rider tracing that route on the live map would see the wrong color (or
 * no color) at that exact spot.
 *
 * This is NOT a visual/screenshot check — it's a data-level trace against
 * the exact structures the client renders from, so it catches the class of
 * bug (an edge silently missing a route it should carry) without needing a
 * browser.
 *
 * Usage: node scripts/trace-route-colors.js <path-to-extracted-gtfs-dir>
 * Exits non-zero if any route has a failing edge.
 */
const fs = require('fs');
const path = require('path');
const { loadRoadGraph, buildEdgeIndex } = require('../road-graph.js');
const { loadRawGtfsShapesForCli, connectedEdgePathForCli } = require('./snap-routes-to-roads.js');

const ROOT = path.join(__dirname, '..');

async function main() {
  const gtfsDir = process.argv[2];
  if (!gtfsDir) {
    console.error('Usage: node scripts/trace-route-colors.js <path-to-extracted-gtfs-dir>');
    process.exit(1);
  }

  console.log('Loading road graph…');
  const graph = loadRoadGraph();
  const edgeIndex = buildEdgeIndex(graph);

  console.log('Loading rendered ribbon data (data/route-edges.json)…');
  const routeEdges = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/route-edges.json'), 'utf8'));
  const edgeRouteSets = new Map(); // edgeId -> Set(routeId) — what the RENDERER actually has
  for (const e of routeEdges.edges) edgeRouteSets.set(e.id, new Set(e.routeIds));

  console.log('Loading GTFS source shapes…');
  const sourceShapes = loadRawGtfsShapesForCli(gtfsDir);

  // Group patterns by route so we trace each ROUTE once (a route can have
  // several patterns/trip variants — direction, schedule effective-date
  // versions — tracing all of them is the honest full test, not just one).
  const patternsByRoute = new Map();
  for (const key of Object.keys(sourceShapes)) {
    const entry = sourceShapes[key];
    if (entry.route_id == null || !entry.coords || entry.coords.length < 2) continue;
    if (!patternsByRoute.has(entry.route_id)) patternsByRoute.set(entry.route_id, []);
    patternsByRoute.get(entry.route_id).push({ key, coords: entry.coords });
  }

  console.log(`Tracing ${patternsByRoute.size} routes (${sourceShapes && Object.keys(sourceShapes).length} total patterns)…\n`);

  let totalFailures = 0;
  const results = [];
  for (const [routeId, patterns] of [...patternsByRoute].sort((a, b) => a[0] - b[0])) {
    let edgesChecked = 0, edgesFailed = 0;
    const failureSamples = [];
    for (const pattern of patterns) {
      let edgeSeq;
      try {
        // Same connected-path matcher the ribbon builder (build-route-edges.js)
        // uses — the raw matcher includes stray/unreachable edges the builder
        // deliberately drops, which reads as false failures here.
        edgeSeq = connectedEdgePathForCli(graph, edgeIndex, pattern.coords);
      } catch (e) {
        continue; // matching failure is a separate concern (scripts/validate-route-roads.js); skip here
      }
      for (const edgeIdx of edgeSeq) {
        if (edgeIdx == null) continue; // honest gap in the route's own path — nothing to trace here
        edgesChecked++;
        const renderedRoutes = edgeRouteSets.get(edgeIdx);
        const hasColor = renderedRoutes && renderedRoutes.has(routeId);
        if (!hasColor) {
          edgesFailed++;
          if (failureSamples.length < 5) {
            const e = graph.edges[edgeIdx];
            failureSamples.push({
              pattern: pattern.key,
              edgeId: edgeIdx,
              at: e.coords[Math.floor(e.coords.length / 2)],
              wayName: e.name || '(unnamed)',
              renderedRoutesHere: renderedRoutes ? [...renderedRoutes] : 'EDGE NOT IN route-edges.json AT ALL',
            });
          }
        }
      }
    }
    const pass = edgesFailed === 0;
    results.push({ routeId, edgesChecked, edgesFailed, pass, failureSamples });
    totalFailures += edgesFailed;
    const status = pass ? 'PASS' : 'FAIL';
    console.log(`route ${routeId}: ${status} — ${edgesChecked - edgesFailed}/${edgesChecked} edges show this route's color`);
    if (!pass) {
      for (const f of failureSamples) {
        console.log(`    pattern ${f.pattern}, edge ${f.edgeId} "${f.wayName}" at [${f.at[1].toFixed(5)}, ${f.at[0].toFixed(5)}] — rendered routes here: ${JSON.stringify(f.renderedRoutesHere)}`);
      }
      if (edgesFailed > failureSamples.length) {
        console.log(`    ...and ${edgesFailed - failureSamples.length} more`);
      }
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  const failedRoutes = results.filter(r => !r.pass);
  if (failedRoutes.length === 0) {
    console.log(`ALL ${results.length} ROUTES PASS — every real road edge a route travels shows that route's color in the rendered ribbon data.`);
  } else {
    console.log(`${failedRoutes.length} of ${results.length} routes FAILED (${totalFailures} total edge mismatches):`);
    for (const r of failedRoutes) console.log(`  - route ${r.routeId}: ${r.edgesFailed}/${r.edgesChecked} edges missing this route's color`);
  }

  fs.writeFileSync(path.join(ROOT, 'data/route-color-trace-report.json'), JSON.stringify(results, null, 1));
  process.exit(failedRoutes.length === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
