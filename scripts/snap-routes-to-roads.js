'use strict';
/**
 * Colors real roads for each route — no snapping math, no stitching, no
 * synthesized coordinates. For each route's GTFS shape, find which real OSM
 * road edges (road-graph.js) it actually runs along, and draw THOSE EDGES'
 * OWN, UNMODIFIED coordinate arrays. An edge's coords are already a verbatim
 * slice of the source OSM way (see road-graph.js's buildGraph — splitting at
 * junctions never interpolates a new point), so nothing here ever invents a
 * coordinate: every point on the map came directly from data/osm/bigisland-roads.json.
 *
 * This replaces an earlier point-snap-and-shortest-path-stitch approach. That
 * approach span up real edge geometry between snap points (the right idea),
 * but a leftover from extending two points "along the same edge" connected
 * the two SNAPPED points with a straight line instead of the edge's own
 * intermediate vertices — which on a sparse, curving OSM way reintroduced the
 * exact diagonal-cutting bug the whole rewrite was meant to eliminate, and
 * the multi-node shortest-path stitching could pick non-obvious detours.
 * Whole-edge selection sidesteps all of it: there is no chord, ever, because
 * nothing is ever sliced mid-edge or stitched node-to-node — an edge is
 * either fully included (real road, start to finish) or not.
 *
 * Algorithm per shape:
 *   1. Downsample the raw GTFS shape to ~8m spacing (dense — a coarser spacing
 *      regularly skips clean over a short real edge between two samples).
 *   2. For each point, find the nearest road-graph edge within a search radius.
 *   3. Collapse consecutive duplicate edge matches, then fold short runs that
 *      are bookended by the SAME edge back into it — covers both unsnapped
 *      gaps (sparse highway vertices) and brief mismatches to a nearby
 *      driveway/connector. Never invents geometry: folding only relabels
 *      which already-real edge a run belongs to.
 *   4. Walk the cleaned edge list and append each edge's FULL coordinate
 *      array, oriented by shared node identity with the path's current last
 *      point. Where two matched edges don't directly touch, try a short
 *      real bridge path (still only whole real edges); otherwise it's an
 *      honest gap — start a new segment rather than bridge with anything
 *      synthesized.
 *   5. Final safety net: collapse any exact-point revisit within a segment
 *      (an out-and-back through already-drawn real road) — pure deletion of
 *      duplicate points, never an addition or move.
 *
 * Usage: node scripts/snap-routes-to-roads.js <path-to-extracted-gtfs-dir>
 * Writes data/route-shapes-road-snapped.json: pattern_id -> { route_id, segments: [encoded,...] }
 */
const fs = require('fs');
const path = require('path');
const { loadRoadGraph, buildEdgeIndex, nearestPointOnGraph, shortestPath, nodeKey, edgeCoordsFrom } = require('../road-graph.js');

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

const SNAP_RADIUS_M = 40;
const SNAP_RADIUS_FALLBACK_M = 150; // rural OSM ways / GTFS points are sparser

// Color the real roads a route travels: which edges, in what order, oriented
// which way — never inventing a coordinate. Sample EVERY ~8m so consecutive
// samples are always on the same edge or an immediately adjacent one — a
// coarser sample (e.g. 25m+) regularly skips clean over a short real edge
// between two samples, which then looks like a "gap" even though the route
// is fully continuous on real roads; this is about matching density, not
// inventing geometry, so it doesn't reintroduce any synthesized point.
function collapseConsecutive(arr) {
  const out = [];
  for (const x of arr) {
    if (out.length && out[out.length - 1] === x) continue;
    out.push(x);
  }
  return out;
}

// Which real road-graph edges (in order, deduplicated, noise-folded) a GTFS
// shape actually travels. Shared by colorRoadsForShape (draws their full
// coordinates) and wayIdsForShape (just needs which OSM ways they came
// from, to recolor the BASEMAP's own road features via setFeatureState
// instead of drawing anything).
function matchedEdgeSequence(graph, edgeIndex, rawCoords) {
  const pts = downsample(rawCoords, 8);
  const snaps = pts.map(p =>
    nearestPointOnGraph(graph, edgeIndex, p, SNAP_RADIUS_M) ||
    nearestPointOnGraph(graph, edgeIndex, p, SNAP_RADIUS_FALLBACK_M));

  // Collapse consecutive duplicate edge matches (many shape points land on
  // the same edge as the bus travels along one road). May still contain
  // `null` for unsnapped samples.
  let edgeSeq = collapseConsecutive(snaps.map(s => s ? s.edgeIdx : null));

  // Fold a short run that's bookended by the SAME edge on both sides back
  // into that edge — whether the run is unsnapped (null) samples (long,
  // sparsely-vertexed OSM ways have GTFS points occasionally fall just
  // outside the snap radius) or a different, briefly-matched edge (snap
  // noise from a nearby driveway/connector). The bus never actually left the
  // bookending edge in either case; treating the run as real causes the path
  // to "leave" and "re-enter" later, which looks like a gap requiring a
  // re-walk of the same edge — a visible retrace. This NEVER invents
  // geometry: folding only relabels which already-real edge a run belongs
  // to, it doesn't change any edge's own coordinates.
  const MAX_FOLD_RUN = 8;
  for (let pass = 0; pass < 5; pass++) {
    let changed = false;
    for (let i = 1; i < edgeSeq.length - 1; i++) {
      if (edgeSeq[i] === edgeSeq[i - 1]) continue; // already same as before, nothing to fold
      let j = i;
      while (j < edgeSeq.length && edgeSeq[j] !== edgeSeq[i - 1]) j++;
      const runLen = j - i;
      if (j < edgeSeq.length && runLen <= MAX_FOLD_RUN) {
        for (let k = i; k < j; k++) edgeSeq[k] = edgeSeq[i - 1];
        changed = true;
      }
    }
    edgeSeq = collapseConsecutive(edgeSeq);
    if (!changed) break;
  }
  return edgeSeq;
}

// ONE fully-connected ordered edge walk for a shape — the organism the ribbon
// needs: no nulls, no floating edges, every consecutive pair shares a graph
// node so the drawn ribbon is a single unbroken chain. Built by taking the
// matched edge sequence and, wherever two consecutive matched edges don't
// already touch, inserting the real shortest road path between them (whole real
// edges only). Any matched edge that can't be reached from the current path end
// within BRIDGE_MAX_M is DROPPED rather than left as a floating segment — the
// bus's own next in-range match will re-anchor the walk. The result is
// guaranteed connected: scripts/diagnose-route-connectivity.js should report 0
// breaks / 0 gaps for every route built from this.
const BRIDGE_MAX_M = 4000; // generous: rural GTFS shapes can skip long stretches between sparse points
function connectedEdgePath(graph, edgeIndex, rawCoords) {
  const rawSeq = matchedEdgeSequence(graph, edgeIndex, rawCoords)
    .filter(x => x != null);
  if (rawSeq.length === 0) return [];

  const out = [];               // ordered edge indices, guaranteed connected
  let curNode = null;           // graph node where the assembled path currently ends

  // Choose the starting orientation of the first edge so its FAR end faces the
  // second matched edge — keeps the natural travel direction.
  const pushEdge = (edgeIdx, entryNode) => {
    const e = graph.edges[edgeIdx];
    // entryNode is the node we arrive at this edge through; leave via the other.
    out.push(edgeIdx);
    curNode = e.a === entryNode ? e.b : e.a;
  };

  for (let s = 0; s < rawSeq.length; s++) {
    const edgeIdx = rawSeq[s];
    const e = graph.edges[edgeIdx];
    if (curNode == null) {
      // First edge. Orient it toward the next matched edge if there is one.
      let entry = e.a;
      if (s + 1 < rawSeq.length) {
        const n = graph.edges[rawSeq[s + 1]];
        // If e.a is closer (shares/near) to next edge, enter via e.b so we exit at e.a toward next.
        const da = Math.min(nodeGapM(graph, e.a, n.a), nodeGapM(graph, e.a, n.b));
        const db = Math.min(nodeGapM(graph, e.b, n.a), nodeGapM(graph, e.b, n.b));
        entry = da < db ? e.b : e.a; // exit toward the nearer end
      }
      pushEdge(edgeIdx, entry);
      continue;
    }

    // Already connected? (edge touches current path end)
    if (e.a === curNode || e.b === curNode) {
      pushEdge(edgeIdx, curNode);
      continue;
    }

    // Not touching — bridge with the real shortest path to whichever end of
    // this edge is reachable and nearer.
    let bridgeToA = shortestPath(graph, curNode, e.a, BRIDGE_MAX_M);
    let bridgeToB = shortestPath(graph, curNode, e.b, BRIDGE_MAX_M);
    let bridge = null, entry = null;
    if (bridgeToA && bridgeToB) {
      // pick shorter (by edge count is a fine proxy; both are real roads)
      if (bridgeToA.length <= bridgeToB.length) { bridge = bridgeToA; entry = e.a; }
      else { bridge = bridgeToB; entry = e.b; }
    } else if (bridgeToA) { bridge = bridgeToA; entry = e.a; }
    else if (bridgeToB) { bridge = bridgeToB; entry = e.b; }

    if (bridge == null) {
      // Genuinely unreachable within the cap — drop this stray match rather
      // than break the chain. (Rare: only if OSM has a true coverage hole.)
      continue;
    }
    // Walk the bridge edges, advancing curNode each step.
    for (const bi of bridge) {
      const be = graph.edges[bi];
      // curNode must be an endpoint of be (shortestPath returns a connected walk).
      pushEdge(bi, curNode);
    }
    // Now curNode === entry (the reachable end of our target edge); append it.
    pushEdge(edgeIdx, curNode);
  }

  // Collapse immediate A-B-A backtracks introduced by bridging into a spur.
  return dedupeImmediateBacktrack(out);
}

function nodeGapM(graph, k1, k2) {
  if (k1 === k2) return 0;
  const n1 = graph.nodes.get(k1), n2 = graph.nodes.get(k2);
  if (!n1 || !n2) return Infinity;
  return distM([n1.lon, n1.lat], [n2.lon, n2.lat]);
}

// Drop an edge that is immediately followed by itself (out-and-back over a
// single edge produced when a bridge overshoots and comes right back).
function dedupeImmediateBacktrack(seq) {
  const out = [];
  for (const e of seq) {
    if (out.length >= 1 && out[out.length - 1] === e) continue;
    if (out.length >= 2 && out[out.length - 2] === e) { out.pop(); continue; }
    out.push(e);
  }
  return out;
}

// Distinct real OSM way IDs (in travel order, deduplicated) a route's shape
// travels along — used to recolor the BASEMAP's own road features directly
// (MapTiler's transportation layer feature.id IS the OSM way id, verified
// against data/osm/bigisland-roads.json), instead of drawing any overlay
// line. No coordinates are produced or needed for this path at all.
function wayIdsForShape(graph, edgeIndex, rawCoords) {
  const edgeSeq = matchedEdgeSequence(graph, edgeIndex, rawCoords);
  const wayIds = [];
  for (const edgeIdx of edgeSeq) {
    if (edgeIdx == null) continue;
    const wayId = graph.edges[edgeIdx].wayId;
    if (wayId != null && wayIds[wayIds.length - 1] !== wayId) wayIds.push(wayId);
  }
  return [...new Set(wayIds)];
}

function colorRoadsForShape(graph, edgeIndex, rawCoords) {
  const edgeSeq = matchedEdgeSequence(graph, edgeIndex, rawCoords);

  // Append one real edge's FULL coordinate array to `current`, oriented so it
  // continues from whichever end touches the path's current last point
  // (matched by NODE IDENTITY, not by tracked "cursor" state — recomputing
  // this fresh from current's actual last point each time, instead of
  // threading a separate cursorNode variable through every branch, is what
  // eliminates the reversed-retrace bug: there is no stale-cursor case left
  // to get out of sync with what was actually emitted).
  // current's endpoints are always exact edge endpoints (every edge we add
  // ends in graph.nodes by construction), so an exact key lookup is valid.
  const nodeOfPoint = (pt) => nodeKey(pt[0], pt[1]);
  const appendEdge = (edgeIdx) => {
    const e = graph.edges[edgeIdx];
    if (!current.length) { current.push(...e.coords); return; }
    const lastNode = nodeOfPoint(current[current.length - 1]);
    const coords = lastNode === e.b ? e.coords.slice().reverse() : e.coords; // lastNode===e.a, or first edge
    current.push(...coords.slice(1));
  };
  const lastNodeOf = () => current.length ? nodeOfPoint(current[current.length - 1]) : null;

  const segments = [];
  let current = [];

  for (const edgeIdx of edgeSeq) {
    if (edgeIdx == null) {
      if (current.length > 1) segments.push(current);
      current = [];
      continue;
    }
    const e = graph.edges[edgeIdx];
    const cursorNode = lastNodeOf();
    if (cursorNode == null || e.a === cursorNode || e.b === cursorNode) {
      appendEdge(edgeIdx);
      continue;
    }
    // This matched edge doesn't directly touch where the path currently
    // ends. Before treating it as a real gap, check whether a short real
    // connecting edge exists that the sparse GTFS sample skipped past (very
    // common — e.g. a short connector between two named-street segments).
    // Every edge the path returns is appended in FULL, exactly as it is in
    // road-graph.js — this only sequences which real edges to draw.
    let bridgePath = shortestPath(graph, cursorNode, e.a, 600);
    if (bridgePath === null) bridgePath = shortestPath(graph, cursorNode, e.b, 600);
    if (bridgePath !== null && bridgePath.length <= 8) {
      for (const bi of bridgePath) appendEdge(bi);
      appendEdge(edgeIdx);
    } else {
      // No short real connection found — an honest gap (sparse shape points
      // skipped something farther than a couple of short connector edges, or
      // real OSM coverage has a hole here). Never bridge it with anything
      // synthesized; start a fresh segment instead.
      if (current.length > 1) segments.push(current);
      current = [...e.coords];
    }
  }
  if (current.length > 1) segments.push(current);
  return segments
    .map(seg => seg.filter(p => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])))
    .map(removeRetraces)
    .filter(seg => seg.length >= 2);
}

// Final safety net: walk an assembled coordinate list and cut out any
// "go to point P, then immediately come straight back through the same
// points" pattern — a route doubling onto itself and back, however it got
// there upstream (the edge-matching above has several legitimate paths to
// occasionally revisit one long, sparse edge non-consecutively, and not
// every such case is worth chasing individually). Detected purely
// geometrically: if position i and position j (j > i) are the SAME point and
// the path from i to j is short relative to a direct jump elsewhere, drop
// the out-and-back in between, since those points are already covered by
// the rest of the path. This only ever DELETES points that are exact
// duplicates of points already in the list — it never adds or moves one.
function removeRetraces(coords) {
  const keyOf = (p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
  const lastSeenAt = new Map();
  const out = [];
  for (let i = 0; i < coords.length; i++) {
    const k = keyOf(coords[i]);
    if (lastSeenAt.has(k)) {
      // Rewind: drop everything emitted since the previous visit to this
      // exact point — that span was an out-and-back through already-real
      // road geometry, now redundant. Any OTHER point's recorded index that
      // falls past the new (shorter) length is now stale and must be purged,
      // or a later match against it would try to "rewind" to an index past
      // the current end — `Array.length = N` for N > out.length doesn't
      // truncate, it pads with holes, which is exactly how a `null`/empty
      // slot was sneaking into the final coordinate list.
      const newLen = lastSeenAt.get(k) + 1;
      out.length = newLen;
      for (const [key, idx] of lastSeenAt) if (idx >= newLen) lastSeenAt.delete(key);
    } else {
      out.push(coords[i]);
      lastSeenAt.set(k, out.length - 1);
    }
  }
  return out;
}

module.exports = {
  colorRoadsForShape, wayIdsForShape, decode, encode, downsample,
  // Exposed for scripts/build-route-edges.js, which needs per-edge (not
  // per-route-concatenated) matching — same real-road matching logic, finer
  // granularity output.
  matchedEdgeSequenceForCli: matchedEdgeSequence,
  connectedEdgePathForCli: connectedEdgePath,
  loadRawGtfsShapesForCli: loadRawGtfsShapes,
};

// Bring in route_id + raw GTFS shape pairing from a downloaded GTFS zip's
// shapes.txt/trips.txt, NOT from a previously-matched/densified file — the
// whole point is to color real roads starting from the agency's actual
// (sparse) shape points, the same input every other matching approach in
// this repo has had to handle.
function loadRawGtfsShapes(gtfsDir) {
  const shapesText = fs.readFileSync(path.join(gtfsDir, 'shapes.txt'), 'utf8');
  const tripsText = fs.readFileSync(path.join(gtfsDir, 'trips.txt'), 'utf8');
  const parseCsv = (text) => {
    const lines = text.trim().split('\n');
    const headers = lines[0].split(',').map(h => h.trim());
    return lines.slice(1).map(line => {
      // naive CSV split is fine here — these files don't quote-escape commas in numeric fields
      const cells = line.split(',');
      const row = {};
      headers.forEach((h, i) => row[h] = cells[i]);
      return row;
    });
  };
  const shapeRows = parseCsv(shapesText);
  const tripRows = parseCsv(tripsText);
  const shapeToRoute = {};
  for (const t of tripRows) if (t.shape_id) shapeToRoute[t.shape_id] = parseInt(t.route_id);

  const byShape = {};
  for (const r of shapeRows) {
    const sid = r.shape_id;
    if (!byShape[sid]) byShape[sid] = [];
    byShape[sid].push({ seq: parseInt(r.shape_pt_sequence), lat: parseFloat(r.shape_pt_lat), lon: parseFloat(r.shape_pt_lon) });
  }
  const out = {};
  for (const sid of Object.keys(byShape)) {
    const pts = byShape[sid].sort((a, b) => a.seq - b.seq);
    out[sid] = { route_id: shapeToRoute[sid] ?? null, coords: pts.map(p => [p.lon, p.lat]) };
  }
  return out;
}

async function loadSourceShapes() {
  const gtfsDir = process.argv[2];
  if (!gtfsDir) {
    console.error('Usage: node scripts/snap-routes-to-roads.js <path-to-extracted-gtfs-dir>');
    console.error('  (the directory must contain shapes.txt and trips.txt)');
    process.exit(1);
  }
  console.log(`Loading raw GTFS shapes from ${gtfsDir} …`);
  return loadRawGtfsShapes(gtfsDir);
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
    if (!entry.coords || entry.coords.length < 2) continue;
    const rawCoords = entry.coords;
    let wayIds, segments;
    try {
      wayIds = wayIdsForShape(graph, edgeIndex, rawCoords);
      segments = colorRoadsForShape(graph, edgeIndex, rawCoords);
    } catch (e) {
      console.error(`  pattern ${key} (route ${entry.route_id}) failed: ${e.message}`);
      failedCount++;
      continue;
    }
    if (!wayIds.length) { failedCount++; continue; }
    out[key] = {
      route_id: entry.route_id,
      wayIds, // real OSM way IDs to recolor directly on the basemap — primary path
      segments: segments.map(seg => encode(seg)), // fallback overlay geometry, same real-road data
    };
    snappedCount++;
    if (snappedCount % 20 === 0) console.log(`  ...${snappedCount} patterns colored`);
  }
  console.log(`Colored ${snappedCount} patterns (${failedCount} produced no usable road path)`);
  fs.writeFileSync(path.join(ROOT, 'data/route-shapes-road-snapped.json'), JSON.stringify(out));
  console.log('Wrote data/route-shapes-road-snapped.json');
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}
