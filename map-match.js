'use strict';
/**
 * Server-side route map-matching.
 *
 * Snaps a route's GTFS shape to the real OpenStreetMap road network so the map
 * draws clean on-road lines instead of the wobbly raw GPS shape — and, critically,
 * REJECTS bad matches (the diagonal "shortcut" and doubling-back artifacts that
 * appear when the matcher bridges a gap onto the wrong parallel street).
 *
 * Runs on the server, on demand, against the free public FOSSGIS Valhalla
 * map-matching endpoint (valhalla.openstreetmap.de). Results are cached by the
 * caller (in the DB, which is checkpointed to durable storage) so each route is
 * matched once and never recomputed unless its shape changes. No local Valhalla,
 * no Docker, no build step — the page needs zero of this at runtime.
 */
const https = require('https');
const http = require('http');

const VALHALLA = process.env.VALHALLA_URL || 'https://valhalla1.openstreetmap.de/trace_route';

function postJson(url, body, timeoutMs = 60000) {
  const lib = url.startsWith('https') ? https : http;
  const data = Buffer.from(JSON.stringify(body));
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = lib.request({
      hostname: u.hostname, path: u.pathname + u.search,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'User-Agent': 'heleon-tracker-shape-matcher' },
      timeout: timeoutMs,
    }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => resolve({ status: r.statusCode, body: b })); });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end(data);
  });
}

// ── Google encoded-polyline codec (1e5 for GTFS, 1e6 for Valhalla output) ──
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

// Downsample to ~`spacing` metres — dense GPS points confuse Valhalla's snapper.
function downsample(pts, spacing = 40) {
  if (pts.length < 2) return pts;
  const ds = [pts[0]];
  for (const p of pts.slice(1)) if (hav(ds[ds.length - 1], p) >= spacing) ds.push(p);
  if (ds[ds.length - 1] !== pts[pts.length - 1]) ds.push(pts[pts.length - 1]);
  return ds;
}

// Perpendicular distance (m) of point p from segment a→b, in local metres.
function perpDist(p, a, b) {
  const mLat = 111320, mLon = mLat * Math.cos(a[0] * Math.PI / 180);
  const ax = a[1] * mLon, ay = a[0] * mLat;
  const bx = b[1] * mLon, by = b[0] * mLat;
  const px = p[1] * mLon, py = p[0] * mLat;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Smallest distance (m) from point p to the polyline `line`.
function distToLine(p, line) {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const d = perpDist(p, line[i - 1], line[i]);
    if (d < best) best = d;
  }
  return best;
}

/**
 * THE ARTIFACT GUARD. A good match hugs the original GTFS corridor the whole way.
 * The artifacts we're killing are where the matched line darts off to a parallel
 * street and back — those points sit far from the original shape. We sample the
 * matched line and measure how far each sample strays from the raw corridor.
 * If too much of the match is off-corridor, OR the matched length deviates too
 * much from the original, we reject the whole match and keep the raw shape.
 *
 * `raw` and `matched` are [[lat,lon],…].
 */
function matchQuality(raw, matched) {
  const rawLen = lineLen(raw), matchedLen = lineLen(matched);
  const lenDrift = Math.abs(matchedLen - rawLen) / (rawLen || 1);
  // Sample matched points and measure stray distance from the raw corridor.
  let strayMax = 0, strayCount = 0, n = 0;
  const step = Math.max(1, Math.floor(matched.length / 400)); // cap work on long routes
  for (let i = 0; i < matched.length; i += step) {
    const d = distToLine(matched[i], raw);
    if (d > strayMax) strayMax = d;
    if (d > 35) strayCount++;   // >35 m off the corridor = on a different street
    n++;
  }
  const strayFrac = n ? strayCount / n : 1;
  return { lenDrift, strayMax, strayFrac, rawLen, matchedLen };
}

async function traceRoute(pts, spacing, opts, costing) {
  const ds = downsample(pts, spacing);
  const body = {
    shape: ds.map(([lat, lon]) => ({ lat, lon })),
    costing: costing || 'auto',
    shape_match: 'map_snap',
    trace_options: Object.assign({ search_radius: 35, gps_accuracy: 10, turn_penalty_factor: 0, breakage_distance: 2000 }, opts || {}),
    directions_options: { units: 'kilometers' },
  };
  const r = await postJson(VALHALLA, body);
  if (r.status !== 200) throw new Error(`valhalla ${r.status}: ${r.body.slice(0, 120)}`);
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

// Long routes exceed Valhalla's per-request distance cap, so a single trace gets
// truncated (huge length drift → rejected). Match in overlapping windows and
// stitch them, so long inter-town lines snap cleanly instead of falling to raw.
async function traceChunked(raw) {
  const ds = downsample(raw, 35);
  const WIN = 80, OVERLAP = 6;
  let out = [];
  for (let start = 0; start < ds.length - 1; start += (WIN - OVERLAP)) {
    const win = ds.slice(start, start + WIN);
    if (win.length < 2) break;
    let seg;
    try { seg = await traceRoute(win, 1, { search_radius: 35, gps_accuracy: 10 }, 'auto'); }
    catch { seg = win; } // a failed window falls back to its own raw points
    if (out.length && seg.length && hav(out[out.length - 1], seg[0]) < 30) seg.shift();
    out = out.concat(seg);
    await new Promise(r => setTimeout(r, 250)); // polite to the public server
  }
  return out;
}

/**
 * Match one route. Returns { encoded, matched, quality, raw:false } on a CLEAN
 * snap, or { encoded:<rawShape>, raw:true, reason } when no attempt was clean
 * enough — so a bad snap is never shown. `encodedShape` is the GTFS polyline.
 */
async function matchShape(encodedShape) {
  const raw = decode(encodedShape, 1e5);
  if (raw.length < 2) return { encoded: encodedShape, raw: true, reason: 'too-few-points' };

  // Only 'auto' costing — it respects one-ways and access, which is exactly what
  // keeps a bus line on its real road. We deliberately DON'T fall back to
  // 'pedestrian' (the old script did): pedestrian routing cuts through service
  // roads and parking lots and is the source of the diagonal artifacts.
  const attempts = [
    [35, { search_radius: 30, gps_accuracy: 8 }],
    [25, { search_radius: 25, gps_accuracy: 6 }],
    [50, { search_radius: 45, gps_accuracy: 14 }],
  ];

  let best = null, bestScore = Infinity;
  for (const [spacing, opts] of attempts) {
    let matched;
    try { matched = await traceRoute(raw, spacing, opts, 'auto'); }
    catch { continue; }
    if (!matched || matched.length < 2) continue;
    const q = matchQuality(raw, matched);
    // Composite badness score: length drift + how much strays off corridor.
    const score = q.lenDrift + q.strayFrac * 2;
    if (score < bestScore) { bestScore = score; best = { matched, q }; }
    // Clean enough — stop early.
    if (q.lenDrift <= 0.08 && q.strayFrac <= 0.02 && q.strayMax <= 60) break;
  }

  // Stray (how much of the match wanders onto OTHER roads) is the true artifact
  // signal — keep it strict. Length drift is more forgiving: long rural routes
  // often get trimmed slightly at the ends, which is still a faithful on-road
  // line, so allow more drift as long as the match stays on the corridor.
  const accept = q => q.lenDrift <= 0.18 && q.strayFrac <= 0.05 && q.strayMax <= 120;

  // If no single-trace attempt hugged the corridor (typically a long route that
  // Valhalla truncated → big length drift), try stitched windows before giving up.
  if (!best || !accept(best.q)) {
    try {
      const chunked = await traceChunked(raw);
      if (chunked && chunked.length > 1) {
        const cq = matchQuality(raw, chunked);
        if (!best || (cq.lenDrift + cq.strayFrac * 2) < (best.q.lenDrift + best.q.strayFrac * 2)) {
          best = { matched: chunked, q: cq };
        }
      }
    } catch { /* keep best-so-far */ }
  }

  if (!best) return { encoded: encodedShape, raw: true, reason: 'no-match' };

  // Final acceptance gate. The match must hug the corridor: very little of it may
  // stray, the worst stray can't be wild, and total length must be close.
  const { q } = best;
  if (!accept(q)) {
    return { encoded: encodedShape, raw: true,
             reason: `rejected drift=${(q.lenDrift * 100).toFixed(0)}% stray=${(q.strayFrac * 100).toFixed(0)}% max=${q.strayMax.toFixed(0)}m` };
  }
  return { encoded: encode(best.matched, 1e5), matched: best.matched, quality: q, raw: false };
}

module.exports = { matchShape, decode, encode };
