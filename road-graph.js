'use strict';
/**
 * Builds a routable graph from the local OSM road extract (data/osm/bigisland-roads.json)
 * and snaps GTFS route shapes onto it, so route lines are drawn as actual subsets of real
 * road geometry — not independently-traced polylines that can drift, diagonal-cut across
 * blocks, or visually diverge from the basemap when a Valhalla match fails or a shape's
 * raw points are sparse.
 *
 * Graph construction:
 *  1. Every way is a chain of [lon,lat] points. Ways connect to each other either at
 *     shared endpoints (most intersections) or where one way's endpoint lands on
 *     another way's INTERIOR (a T-junction — the through road wasn't split in OSM).
 *  2. We split every way at any point that's a junction (shared with another way,
 *     whether at an endpoint or interior), so the final graph has exactly one edge
 *     per road segment between two junction nodes — clean for shortest-path routing.
 *  3. Each node is a quantized [lon,lat] (rounded to ~1m) so floating-point GPS jitter
 *     in the source data doesn't silently create duplicate, disconnected nodes for what
 *     is geometrically the same intersection.
 */
const fs = require('fs');
const path = require('path');

const QUANT = 1e6; // ~0.11m at this latitude — enough precision to never merge real distinct nodes
function nodeKey(lon, lat) { return `${Math.round(lon * QUANT)},${Math.round(lat * QUANT)}`; }

function buildGraph(roads) {
  // Pass 1: find every coordinate that's a junction — appears as an endpoint of some
  // way AND is also touched (as endpoint or interior point) by at least one other way.
  const pointWays = new Map(); // nodeKey -> Set(wayIndex) of ways touching this exact point
  roads.forEach((w, wi) => {
    w.coords.forEach(([lon, lat]) => {
      const k = nodeKey(lon, lat);
      (pointWays.get(k) || pointWays.set(k, new Set()).get(k)).add(wi);
    });
  });

  const isJunction = (lon, lat) => (pointWays.get(nodeKey(lon, lat))?.size || 0) > 1;

  // Pass 2: split each way into edges at every junction point (always including its
  // own endpoints), so every edge is junction-to-junction with no hidden mid-edge forks.
  const nodes = new Map(); // nodeKey -> { lon, lat, edges: [edgeIdx,...] }
  const edges = []; // { a: nodeKey, b: nodeKey, coords: [[lon,lat],...], hw, name, lengthM }

  const ensureNode = (lon, lat) => {
    const k = nodeKey(lon, lat);
    if (!nodes.has(k)) nodes.set(k, { lon, lat, edges: [] });
    return k;
  };

  function distM(a, b) {
    const R = 6371000;
    const mPerDegLat = 111320, mPerDegLon = mPerDegLat * Math.cos(a[1] * Math.PI / 180);
    return Math.hypot((b[0]-a[0])*mPerDegLon, (b[1]-a[1])*mPerDegLat);
  }

  for (const w of roads) {
    let segStart = 0;
    for (let i = 1; i < w.coords.length; i++) {
      const isLast = i === w.coords.length - 1;
      if (isLast || isJunction(w.coords[i][0], w.coords[i][1])) {
        const segCoords = w.coords.slice(segStart, i + 1);
        if (segCoords.length < 2) { segStart = i; continue; }
        const aKey = ensureNode(segCoords[0][0], segCoords[0][1]);
        const bKey = ensureNode(segCoords[segCoords.length-1][0], segCoords[segCoords.length-1][1]);
        if (aKey === bKey) { segStart = i; continue; } // zero-length / duplicate-point edge
        let lengthM = 0;
        for (let j = 1; j < segCoords.length; j++) lengthM += distM(segCoords[j-1], segCoords[j]);
        const edgeIdx = edges.length;
        edges.push({ a: aKey, b: bKey, coords: segCoords, hw: w.hw, name: w.name, lengthM });
        nodes.get(aKey).edges.push(edgeIdx);
        nodes.get(bKey).edges.push(edgeIdx);
        segStart = i;
      }
    }
  }

  return { nodes, edges, nodeKey };
}

function loadRoadGraph(roadsPath) {
  const roads = JSON.parse(fs.readFileSync(roadsPath || path.join(__dirname, 'data/osm/bigisland-roads.json')));
  return buildGraph(roads);
}

// ── Spatial index over edges for fast nearest-point lookup ──
function buildEdgeIndex(graph, cellDeg = 0.001) {
  const grid = new Map();
  const cellKey = (lon, lat) => `${Math.round(lon / cellDeg)},${Math.round(lat / cellDeg)}`;
  graph.edges.forEach((e, ei) => {
    const seen = new Set();
    for (const [lon, lat] of e.coords) {
      const k = cellKey(lon, lat);
      if (seen.has(k)) continue;
      seen.add(k);
      let list = grid.get(k);
      if (!list) { list = []; grid.set(k, list); }
      list.push(ei);
    }
  });
  return { grid, cellDeg };
}

function distToSegM(p, a, b) {
  const mPerDegLat = 111320, mPerDegLon = mPerDegLat * Math.cos(p[1] * Math.PI / 180);
  const px = p[0]*mPerDegLon, py = p[1]*mPerDegLat;
  const ax = a[0]*mPerDegLon, ay = a[1]*mPerDegLat;
  const bx = b[0]*mPerDegLon, by = b[1]*mPerDegLat;
  const dx = bx-ax, dy = by-ay, len2 = dx*dx+dy*dy || 1;
  let t = ((px-ax)*dx + (py-ay)*dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax+dx*t, cy = ay+dy*t;
  return { dist: Math.hypot(px-cx, py-cy), t };
}

// Nearest point ON THE ROAD NETWORK to `pt`, within `radiusM`. Returns the exact
// snapped [lon,lat], which edge it's on, and the fractional position along that
// edge's point list (segIdx + t) — NOT forced to an edge endpoint, so a bus in the
// middle of a long block snaps to where it actually is, not to the nearest corner.
function nearestPointOnGraph(graph, edgeIndex, pt, radiusM) {
  const { grid, cellDeg } = edgeIndex;
  const cellSpan = Math.ceil(radiusM / (cellDeg * 111320)) + 1;
  const baseLon = Math.round(pt[0] / cellDeg), baseLat = Math.round(pt[1] / cellDeg);
  let best = null, bestDist = Infinity;
  const seen = new Set();
  for (let dy = -cellSpan; dy <= cellSpan; dy++) for (let dx = -cellSpan; dx <= cellSpan; dx++) {
    const list = grid.get(`${baseLon+dx},${baseLat+dy}`);
    if (!list) continue;
    for (const ei of list) {
      if (seen.has(ei)) continue;
      seen.add(ei);
      const e = graph.edges[ei];
      for (let i = 0; i < e.coords.length - 1; i++) {
        const { dist, t } = distToSegM(pt, e.coords[i], e.coords[i+1]);
        if (dist < bestDist) {
          bestDist = dist;
          best = { edgeIdx: ei, segIdx: i, t };
        }
      }
    }
  }
  if (!best || bestDist > radiusM) return null;
  const e = graph.edges[best.edgeIdx];
  const a = e.coords[best.segIdx], b = e.coords[best.segIdx + 1];
  const snapped = [a[0] + (b[0]-a[0])*best.t, a[1] + (b[1]-a[1])*best.t];
  return { ...best, dist: bestDist, point: snapped };
}

// Dijkstra shortest path (by length) between two nodes. Capped search radius
// (maxM) keeps it bounded even on the full-island graph — searches are
// geographically local (consecutive GTFS shape points are close together), so
// only a few hundred nodes get visited before either reaching the target or
// hitting the cap.
function shortestPath(graph, fromNode, toNode, maxM = 3000) {
  if (fromNode === toNode) return [];
  const dist = new Map([[fromNode, 0]]);
  const prevEdge = new Map();
  const visited = new Set();
  const queue = [fromNode];
  while (queue.length) {
    queue.sort((a, b) => dist.get(a) - dist.get(b));
    const u = queue.shift();
    if (visited.has(u)) continue;
    visited.add(u);
    if (u === toNode) break;
    const d0 = dist.get(u);
    if (d0 > maxM) break;
    const node = graph.nodes.get(u);
    if (!node) continue;
    for (const ei of node.edges) {
      const e = graph.edges[ei];
      const v = e.a === u ? e.b : e.a;
      if (visited.has(v)) continue;
      const nd = d0 + e.lengthM;
      if (nd < (dist.get(v) ?? Infinity)) {
        dist.set(v, nd);
        prevEdge.set(v, { from: u, edgeIdx: ei });
        queue.push(v);
      }
    }
  }
  if (!dist.has(toNode)) return null; // unreachable within maxM
  const edgePath = [];
  let cur = toNode;
  while (cur !== fromNode) {
    const step = prevEdge.get(cur);
    if (!step) return null;
    edgePath.push(step.edgeIdx);
    cur = step.from;
  }
  edgePath.reverse();
  return edgePath;
}

// Coordinates for an edge traversed from `fromNode` to its other end — orients
// the edge's point list in the direction of travel.
function edgeCoordsFrom(graph, edgeIdx, fromNode) {
  const e = graph.edges[edgeIdx];
  return e.a === fromNode ? e.coords : e.coords.slice().reverse();
}

module.exports = {
  buildGraph, loadRoadGraph, nodeKey,
  buildEdgeIndex, nearestPointOnGraph,
  shortestPath, edgeCoordsFrom,
};
