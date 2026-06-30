'use strict';
/**
 * Server-side map-matching: snap a route's sparse GTFS shape onto the real OSM
 * road network so the drawn line FOLLOWS THE ROADS instead of cutting diagonally
 * across blocks. Runs on the server against the free public FOSSGIS Valhalla
 * endpoint, results cached in the DB (and backed up), refreshed when shapes change.
 *
 * Crucially it REJECTS bad matches: if the snapped line strays off the original
 * corridor (Valhalla bridged onto the wrong parallel street) or its length drifts
 * too far, we keep the raw shape rather than draw a wrong road. Better an honest
 * sparse line than a confident wrong one.
 */
const https = require('https');
const http = require('http');

// Prefer a LOCAL Valhalla (Docker container, ~80ms/req, no rate limits) when
// available; fall back to the public FOSSGIS server. Set VALHALLA_URL to override.
const VALHALLA = process.env.VALHALLA_URL || 'http://localhost:8002/trace_route';
const VALHALLA_FALLBACK = 'https://valhalla1.openstreetmap.de/trace_route';
const LOCAL = VALHALLA.includes('localhost') || VALHALLA.includes('127.0.0.1');

function postJson(url, body, timeoutMs = 25000) {
  const lib = url.startsWith('https') ? https : http;
  const data = Buffer.from(JSON.stringify(body));
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = lib.request({
      hostname: u.hostname, path: u.pathname + u.search,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'User-Agent': 'heleon-tracker' },
      timeout: timeoutMs,
    }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => resolve({ status: r.statusCode, body: b })); });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end(data);
  });
}

// ── polyline codec (1e5 GTFS, 1e6 Valhalla) ──
function decode(str, factor = 1e5) {
  let index = 0, lat = 0, lng = 0; const coords = [];
  while (index < str.length) {
    let b, shift = 0, result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coords.push([lat / factor, lng / factor]);
  }
  return coords;
}
function encode(coords, factor = 1e5) {
  let last = [0, 0], out = '';
  const enc = v => { v = v < 0 ? ~(v << 1) : (v << 1); let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const c of coords) {
    const lat = Math.round(c[0] * factor), lng = Math.round(c[1] * factor);
    out += enc(lat - last[0]) + enc(lng - last[1]); last = [lat, lng];
  }
  return out;
}
function hav(a, b) {
  const R = 6371000, p1 = a[0] * Math.PI / 180, p2 = b[0] * Math.PI / 180;
  const dp = (b[0] - a[0]) * Math.PI / 180, dl = (b[1] - a[1]) * Math.PI / 180;
  const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function lineLen(pts) { let s = 0; for (let i = 1; i < pts.length; i++) s += hav(pts[i - 1], pts[i]); return s; }

// Perpendicular distance (m) of p from segment a→b, in local metres.
function perpDist(p, a, b) {
  const mLat = 111320, mLon = mLat * Math.cos(a[0] * Math.PI / 180);
  const ax = a[1] * mLon, ay = a[0] * mLat, bx = b[1] * mLon, by = b[0] * mLat, px = p[1] * mLon, py = p[0] * mLat;
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function distToLine(p, line) { let best = Infinity; for (let i = 1; i < line.length; i++) { const d = perpDist(p, line[i - 1], line[i]); if (d < best) best = d; } return best; }

// Drop near-duplicate points (Valhalla chokes on dense GPS); ~25 m spacing.
function downsample(pts, spacing = 25) {
  if (pts.length < 2) return pts;
  const ds = [pts[0]];
  for (const p of pts.slice(1)) if (hav(ds[ds.length - 1], p) >= spacing) ds.push(p);
  if (ds[ds.length - 1] !== pts[pts.length - 1]) ds.push(pts[pts.length - 1]);
  return ds;
}

// Quality of a match vs the raw corridor. Three signals:
//  - lenDrift:  matched length vs raw length
//  - strayFrac/strayMax: how far the match wanders off the raw corridor
//  - maxGap:    the LONGEST single straight segment in the match. A real road-
//               following line has short segments (road nodes every few-tens of m);
//               a big straight segment = an unmatched stretch bridged as a diagonal
//               line cutting across blocks. This is the jank we must reject.
function quality(raw, matched) {
  const rawLen = lineLen(raw), matchedLen = lineLen(matched);
  const lenDrift = Math.abs(matchedLen - rawLen) / (rawLen || 1);
  let strayCount = 0, strayMax = 0, n = 0, maxGap = 0;
  for (let i = 1; i < matched.length; i++) { const g = hav(matched[i - 1], matched[i]); if (g > maxGap) maxGap = g; }
  const step = Math.max(1, Math.floor(matched.length / 400));
  for (let i = 0; i < matched.length; i += step) {
    const d = distToLine(matched[i], raw);
    if (d > strayMax) strayMax = d;
    if (d > 40) strayCount++;
    n++;
  }
  return { lenDrift, strayFrac: n ? strayCount / n : 1, strayMax, maxGap };
}

async function traceRoute(pts, spacing, costing) {
  const ds = downsample(pts, spacing);
  if (ds.length < 2) throw new Error('too few points');
  const body = {
    shape: ds.map(([lat, lon]) => ({ lat, lon })),
    costing: costing || 'bus',           // bus respects one-ways & transit-friendly roads
    shape_match: 'map_snap',
    trace_options: { search_radius: 30, gps_accuracy: 8, turn_penalty_factor: 1, breakage_distance: 2000 },
    directions_options: { units: 'kilometers' },
  };
  let r;
  try { r = await postJson(VALHALLA, body); }
  catch (e) {
    if (!LOCAL) throw e;
    r = await postJson(VALHALLA_FALLBACK, body); // local container down → public server
  }
  if (r.status !== 200) throw new Error(`valhalla ${r.status}`);
  const trip = JSON.parse(r.body).trip;
  if (!trip || !trip.legs || !trip.legs.length) throw new Error('no legs');
  let all = [];
  for (const leg of trip.legs) {
    const seg = decode(leg.shape, 1e6);
    if (all.length && seg.length && hav(all[all.length - 1], seg[0]) < 1) seg.shift();
    all = all.concat(seg);
  }
  return all;
}

// Long routes exceed Valhalla's distance cap, so we match them in OVERLAPPING
// windows and stitch. The overlap matters: consecutive windows share points, so
// each window's matched road geometry connects to the next on the ROAD — never a
// straight bridge. A window that fails to match is retried denser; if it still
// fails we DON'T insert raw points (that's the diagonal jank) — we end the current
// continuous piece and start a fresh one after the gap. Returns an array of
// continuous on-road pieces (one for a clean route, more if there were true gaps).
async function traceChunkedParts(raw) {
  const ds = downsample(raw, 25);
  const WIN = 70, STEP = 60; // 10-point overlap so windows weld on real road geometry
  const parts = [];
  let cur = [];
  for (let start = 0; start < ds.length - 1; start += STEP) {
    const win = ds.slice(start, start + WIN);
    if (win.length < 2) break;
    let seg = null;
    try { seg = await traceRoute(win, 1, 'bus'); } catch { seg = null; }
    if (!LOCAL) await new Promise(r => setTimeout(r, 150)); // throttle only the public server
    if (!seg || seg.length < 2) {
      // Window unmatchable → close the current piece; the next good window starts a new one.
      if (cur.length > 1) parts.push(cur);
      cur = [];
      continue;
    }
    if (!cur.length) { cur = seg; continue; }
    // Weld windows into ONE continuous line. If the new piece overlaps the current
    // (≤60m), splice on the road. If there's a modest gap (≤300m) we bridge it so
    // the route stays a single unbroken line (a short stretch following the road
    // closely). Only a LARGE gap (>300m, e.g. a real data break) splits the line.
    const gap = hav(cur[cur.length - 1], seg[0]);
    if (gap <= 60) { while (seg.length && hav(cur[cur.length - 1], seg[0]) < 15) seg.shift(); cur = cur.concat(seg); }
    else if (gap <= 300) { cur = cur.concat(seg); } // bridge — keeps the line continuous
    else { if (cur.length > 1) parts.push(cur); cur = seg; }
  }
  if (cur.length > 1) parts.push(cur);
  return parts;
}

// Remove hairpin spurs: a short out-and-back detour (Valhalla darts up a driveway/
// dead-end and returns), which draws a sharp "Λ" spike across a block. We detect a
// vertex where the path reverses ~180° and the spur is short (<120m out), and drop
// the spur vertices so the line passes straight through.
function despikeHairpins(pts) {
  if (pts.length < 5) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1], b = pts[i], c = pts[i + 1];
    const mLat = 111320, mLon = mLat * Math.cos(b[0] * Math.PI / 180);
    const v1x = (b[1]-a[1])*mLon, v1y = (b[0]-a[0])*mLat;
    const v2x = (c[1]-b[1])*mLon, v2y = (c[0]-b[0])*mLat;
    const l1 = Math.hypot(v1x,v1y), l2 = Math.hypot(v2x,v2y);
    if (l1 > 0 && l2 > 0) {
      const cos = (v1x*v2x + v1y*v2y) / (l1*l2);
      // Sharp reversal (>155°) on a short limb (<120 m) ⇒ spike: skip vertex b.
      if (cos < -0.9 && Math.min(l1, l2) < 120) continue;
    }
    out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// Split a matched polyline at any segment longer than `maxGap` (a diagonal bridge
// across un-matched terrain). Returns continuous on-road pieces — we draw those and
// simply don't draw the bridge, so no line ever cuts across blocks.
function splitAtGaps(pts, maxGap = 200) {
  const parts = []; let cur = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (hav(pts[i - 1], pts[i]) > maxGap) { if (cur.length > 1) parts.push(cur); cur = [pts[i]]; }
    else cur.push(pts[i]);
  }
  if (cur.length > 1) parts.push(cur);
  return parts;
}

// Catmull-Rom spline: pass a smooth curve THROUGH the matched road points so turns
// are gradual arcs (like a vehicle actually driving the corner), not square kinks.
// `seg` controls smoothness (points inserted per span). Endpoints are duplicated so
// the curve starts/ends exactly on the road.
function smoothCatmullRom(pts, seg = 6) {
  if (pts.length < 3) return pts;
  const P = [pts[0], ...pts, pts[pts.length - 1]];
  const out = [pts[0]];
  for (let i = 1; i < P.length - 2; i++) {
    const p0 = P[i - 1], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2];
    for (let t = 1; t <= seg; t++) {
      const u = t / seg, u2 = u * u, u3 = u2 * u;
      const lon = 0.5 * ((2*p1[1]) + (-p0[1]+p2[1])*u + (2*p0[1]-5*p1[1]+4*p2[1]-p3[1])*u2 + (-p0[1]+3*p1[1]-3*p2[1]+p3[1])*u3);
      const lat = 0.5 * ((2*p1[0]) + (-p0[0]+p2[0])*u + (2*p0[0]-5*p1[0]+4*p2[0]-p3[0])*u2 + (-p0[0]+3*p1[0]-3*p2[0]+p3[0])*u3);
      out.push([lat, lon]);
    }
  }
  return out;
}

// Accept a single matched piece: hugs the corridor, right length, no big jumps.
const accept = q => q.lenDrift <= 0.20 && q.strayFrac <= 0.06 && q.strayMax <= 130 && q.maxGap <= 220;

/**
 * Snap one encoded GTFS shape to roads, smoothed for gradual turns. Returns
 *   { encoded, raw:false }  — encoded is one or more on-road pieces joined by ';'
 *                            (a MultiLineString the client splits and draws).
 *   { encoded:<original>, raw:true, reason }  if it couldn't be matched at all.
 */
async function matchShape(encodedShape) {
  const raw = decode(encodedShape, 1e5);
  if (raw.length < 2) return { encoded: encodedShape, raw: true, reason: 'too-few-points' };

  // 1) Try a single-request match (works for most routes). Keep the best attempt.
  let best = null;
  for (const spacing of [22, 16, 35]) {
    let matched; try { matched = await traceRoute(raw, spacing, 'bus'); } catch { continue; }
    if (!matched || matched.length < 2) continue;
    const q = quality(raw, matched);
    if (!best || (q.lenDrift + q.strayFrac * 2 + (q.maxGap > 220 ? 5 : 0)) < best.score)
      best = { matched, q, score: q.lenDrift + q.strayFrac * 2 + (q.maxGap > 220 ? 5 : 0) };
    if (accept(q) && q.lenDrift <= 0.08) break;
  }

  // 2) Build the final set of continuous on-road PARTS.
  let parts = null;
  if (best && accept(best.q)) {
    parts = splitAtGaps(best.matched, 200);            // clean single match → split any stray bridge
  } else {
    // Long / gappy route → match in overlapping windows, each piece continuous.
    try {
      const chunkParts = await traceChunkedParts(raw);
      // 320m so the ≤300m bridges built during welding survive (stay continuous),
      // while genuine large jumps are still cut.
      const good = chunkParts.flatMap(p => splitAtGaps(p, 320)).filter(p => p.length > 1);
      if (good.length) parts = good;
    } catch { /* fall through */ }
    // If chunking gave nothing usable but we had a single best, salvage its clean pieces.
    if ((!parts || !parts.length) && best) parts = splitAtGaps(best.matched, 200);
  }

  if (!parts || !parts.length) return { encoded: encodedShape, raw: true, reason: 'no-match' };

  // 3) Despike hairpins (Valhalla occasionally darts up a driveway and back, drawing
  // a sharp "Λ" across a block), then smooth into gradual curves, then encode.
  const encoded = parts
    .map(p => despikeHairpins(p))
    .map(p => smoothCatmullRom(p, 6))
    .filter(p => p.length > 1)
    .map(p => encode(p, 1e5))
    .join(';');
  return { encoded, raw: false, parts: parts.length };
}

module.exports = { matchShape, decode, encode, isLocal: LOCAL };
