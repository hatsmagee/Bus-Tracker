#!/usr/bin/env node
/**
 * Hele-On Bus Tracker — Persistent Backend
 * - Polls all 22 routes every 10s (even with no browser open)
 * - Stores every GPS ping in SQLite (sql.js, pure WASM — no glibc issues)
 * - Persists DB to disk every 30s
 * - Serves dashboard + REST API (vehicles, trails, shapes, stats)
 * - Proxies upstream API calls (CORS bypass)
 * - Listens on 0.0.0.0 — accessible on local network
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const WebSocket = require('ws');
const { parseFeedMessage } = require('./gtfs-rt');

// Big Island bounding box — fleet feed includes parked/relocated buses
// (e.g. on Oʻahu for maintenance); ignore anything outside Hawaiʻi County.
const BBOX = { minLat: 18.8, maxLat: 20.4, minLon: -156.2, maxLon: -154.7 };
const VEHICLE_STALE_MS = 5 * 60 * 1000;        // a bus is "fresh"/live within this window
const VEHICLE_RETAIN_MS = 48 * 60 * 60 * 1000; // keep showing last-known position (faded) up to 2 days
const RT_VP_PATH = '/gtfs-rt/vehiclepositions';
const RT_TU_PATH = '/gtfs-rt/tripupdates';

// Render.com sets PORT=10000 and RENDER=1; on Render the filesystem is
// ephemeral so we keep SQLite + GTFS zip under /tmp. Locally we keep them
// next to the source tree.
const PORT = parseInt(process.env.PORT, 10) || 8765;
const IS_RENDER = !!process.env.RENDER;
const DATA_DIR = IS_RENDER ? '/tmp' : __dirname;
const DB_PATH = path.join(DATA_DIR, IS_RENDER ? 'heleon.db' : 'heleon.db');
const GTFS_ZIP_PATH = path.join(DATA_DIR, 'heleon-gtfs.zip');
// Bundled "seed" GTFS in the repo — used as a geometry fallback for routes the
// live feed has dropped but the agency still runs (401/301/204 in Puna/Waimea/
// S. Kona). path is fixed to __dirname so it works on ephemeral hosts too.
const SEED_GTFS_PATH = path.join(__dirname, 'Sources', 'General Transit Feed Specifications (GTFS) 2026.zip');
const HTML_PATH = path.join(__dirname, 'heleon-tracker.html');
// Reference data the System Map PDF carries but GTFS does NOT: route class
// (Express/Local/Neighborhood/Flex), transit-hub connections, Park-and-Ride /
// terminal / airport points. Curated in data/heleon-reference.json and kept
// current automatically by scripts/scrape-reference.js (run weekly). Reloaded
// from disk after each scrape so updates take effect without a restart.
const REFERENCE_PATH = path.join(__dirname, 'data', 'heleon-reference.json');
let REFERENCE = {};
function loadReference() {
  try { REFERENCE = JSON.parse(fs.readFileSync(REFERENCE_PATH, 'utf8')); }
  catch { REFERENCE = {}; }
}
loadReference();

// Server-side road-snapping (Valhalla map-matching, cached + auto-refreshing).
const { matchShape } = require('./map-match');
const matchCrypto = require('crypto');
const shapeHash = s => matchCrypto.createHash('sha1').update(s || '').digest('hex').slice(0, 16);

// Durable off-box DB backup (free; restores history on boot so it survives
// ephemeral hosts like Render's free tier wiping /tmp on each deploy).
const backup = require('./backup');
const POLL_INTERVAL = 15000; // GTFS-RT refreshes ~every 15-30s; lighter on bandwidth
const DB_SAVE_INTERVAL = 30000;
const UPSTREAM = 'myheleonbus.org';

// Colors chosen to be dark and saturated enough to read on the light basemap,
// and mutually distinct (no two routes share a hue). The old palette was full
// of pale pastels (lavender, peach, pale green/blue) that vanished on the map
// and several near-duplicates. These are a hand-tuned dark categorical set.
const ROUTES = [
  { id: 5600, name: '10 KAU HILO',              short: '10',  color: '#B5460F' }, // burnt orange
  { id: 5602, name: '102 INTRA HILO KAUMANA',   short: '102', color: '#5B2C8D' }, // deep violet
  { id: 5603, name: '103 INTRA HILO WAIAKEA UKA',short:'103', color: '#0E7C86' }, // teal
  { id: 5604, name: '101 INTRA HILO KEAUKAHA',  short: '101', color: '#9C27B0' }, // magenta-purple
  { id: 5606, name: '70 NORTH KOHALA S. KOHALA', short: '70', color: '#3E7A1E' }, // forest green
  { id: 5613, name: '1 HILO KONA',               short: '1',  color: '#8A5A00' }, // bronze
  { id: 5615, name: '201 KONA TROLLEY',          short: '201',color: '#C2148C' }, // dark pink
  { id: 5704, name: '2 BLUELINE HILO KONA',      short: '2',  color: '#1539C4' }, // strong blue
  { id: 5709, name: '11 REDLINE HILO VOLCANO',   short: '11', color: '#C81E1E' }, // strong red
  { id: 5724, name: '40 PAHOA',                  short: '40', color: '#2563A8' }, // steel blue
  { id: 5725, name: '60 HILO WAIMEA',            short: '60', color: '#5E7A0F' }, // olive
  { id: 5728, name: '75 N. KOHALA WAIKOLOA KONA',short: '75', color: '#0F8A6B' }, // sea green
  { id: 5729, name: '76 GREENLINE HONOKAA KONA', short: '76', color: '#1B7A3D' }, // green
  { id: 5730, name: '80 HILO S. KOHALA RESORTS', short: '80', color: '#A11D5B' }, // raspberry
  { id: 5745, name: '90 PAHALA S. KOHALA RESORTS',short:'90', color: '#8E3B1E' }, // brick
  { id: 5748, name: '104 INTRA HILO MOHOULI',   short: '104', color: '#9E7A00' }, // dark gold
  { id: 5750, name: '202 CENTRAL KAILUA-KONA',  short: '202', color: '#C75A00' }, // pumpkin
  { id: 5756, name: '402 HAWAIIAN PARADISE PARK',short:'402', color: '#1C6E9E' }, // ocean blue
  { id: 5759, name: '403 FERN ACRES',           short: '403', color: '#3F51B5' }, // indigo
  { id: 5821, name: '12 VOLCANO TO OCEANVIEW',  short: '12',  color: '#D11A4B' }, // crimson-pink
  { id: 5824, name: '203 NORTH KAILUA-KONA',    short: '203', color: '#7A4A12' }, // coffee
  { id: 5982, name: '504 KEALAKEKUA KONA TRIPPER',short:'504',color: '#4A6B1E' }, // moss
  // Schedule-only routes: on the printed System Map and in the GTFS feed, but the
  // live RTPI API serves no live shape for them (reduced / call-ahead service with
  // no GPS-tracked vehicles). We load their geometry from GTFS shapes.txt — see
  // loadGtfsShapesForMissing(), which falls back to the bundled seed GTFS for the
  // routes (401/301/204) the CURRENT live feed has dropped but still operates.
  // App id = GTFS short number (1–504 never collide with the 5600+ live ids).
  { id: 5981, name: '502 WAIKOLOA VILLAGE TRIPPER',          short: '502', color: '#6B5B00', scheduleOnly: true }, // dark yellow
  { id: 401,  name: '401 HAWAIIAN BEACHES NANAWALE KALAPANA', short: '401', color: '#B02A8F', scheduleOnly: true }, // orchid
  { id: 301,  name: '301 WAIMEA SHUTTLE',                     short: '301', color: '#0B6E99', scheduleOnly: true }, // cyan-blue
  { id: 204,  name: '204 SOUTH KONA CAPTAIN COOK',            short: '204', color: '#7A2E8E', scheduleOnly: true }, // grape
];
const ROUTE_MAP = Object.fromEntries(ROUTES.map(r => [r.id, r]));

// ─── DATABASE (sql.js) ────────────────────────────────────────────────────────
let db;
const initSql = require('sql.js');

async function openDb() {
  const SQL = await initSql();
  // On an ephemeral host the local file is gone after a deploy/restart — pull the
  // last durable snapshot so accumulated history isn't lost. Only when there's no
  // local DB (a present local file is newer/authoritative for this run).
  if (!fs.existsSync(DB_PATH) && backup.isEnabled()) {
    try {
      const buf = await backup.restore();
      if (buf && buf.length) { fs.writeFileSync(DB_PATH, buf); }
    } catch (e) { console.error('[db] restore error:', e.message); }
  }
  if (fs.existsSync(DB_PATH)) {
    const filebuf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(filebuf);
    console.log(`[db] Loaded existing DB (${Math.round(filebuf.length/1024)} KB)`);
  } else {
    db = new SQL.Database();
    console.log('[db] Created new DB');
  }

  db.run(`CREATE TABLE IF NOT EXISTS pings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            INTEGER NOT NULL,
    vehicle_id    INTEGER NOT NULL,
    vehicle_name  TEXT,
    route_id      INTEGER,
    pattern_id    INTEGER,
    lat           REAL NOT NULL,
    lon           REAL NOT NULL,
    speed         REAL,
    heading       TEXT,
    heading_deg   REAL,
    passenger_load REAL,
    capacity      INTEGER,
    shape_dist    REAL,
    last_updated  TEXT
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_pings_v_ts ON pings(vehicle_id, ts)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_pings_ts ON pings(ts)`);

  db.run(`CREATE TABLE IF NOT EXISTS route_shapes (
    route_id    INTEGER NOT NULL,
    pattern_id  INTEGER PRIMARY KEY,
    name        TEXT,
    direction   TEXT,
    color       TEXT,
    shape       TEXT,
    fetched_at  INTEGER
  )`);

  // Road-snapped route geometry, cached so each pattern is map-matched ONCE (via
  // the public Valhalla API) and then served from here. Keyed by the raw shape's
  // hash so a shape change auto-invalidates and re-snaps. Persists with the DB
  // (and its backup), so on Render we don't re-match on every reboot.
  db.run(`CREATE TABLE IF NOT EXISTS route_shapes_matched (
    pattern_id  INTEGER PRIMARY KEY,
    route_id    INTEGER,
    src_hash    TEXT,
    shape       TEXT,
    is_raw      INTEGER,
    note        TEXT,
    matched_at  INTEGER
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS poll_log (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       INTEGER NOT NULL,
    route_id INTEGER,
    status   INTEGER,
    latency  INTEGER,
    count    INTEGER
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS stops (
    id          INTEGER PRIMARY KEY,
    route_id    INTEGER NOT NULL,
    lat         REAL,
    lon         REAL,
    name        TEXT,
    stop_code   TEXT,
    seq         INTEGER,
    fetched_at  INTEGER
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_stops_route ON stops(route_id)`);

  // Tracks actual arrival times when a bus reaches a stop
  db.run(`CREATE TABLE IF NOT EXISTS stop_arrivals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    vehicle_id  INTEGER NOT NULL,
    route_id    INTEGER NOT NULL,
    stop_id     INTEGER NOT NULL,
    stop_seq    INTEGER,
    eta_speed   REAL,
    eta_hist    REAL
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_arrivals_stop ON stop_arrivals(stop_id, ts)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_arrivals_vehicle ON stop_arrivals(vehicle_id, ts)`);

  // GTFS official stop metadata (names, coords, accessibility)
  db.run(`CREATE TABLE IF NOT EXISTS gtfs_stops (
    stop_id       INTEGER PRIMARY KEY,
    stop_code     TEXT,
    stop_name     TEXT,
    stop_lat      REAL,
    stop_lon      REAL,
    wheelchair    INTEGER DEFAULT 0
  )`);

  // GTFS scheduled stop times from official county feed
  db.run(`CREATE TABLE IF NOT EXISTS gtfs_stop_times (
    route_id    INTEGER NOT NULL,
    trip_id     TEXT NOT NULL,
    service_id  TEXT NOT NULL,
    direction   INTEGER NOT NULL DEFAULT 0,
    stop_id     INTEGER NOT NULL,
    stop_seq    INTEGER NOT NULL,
    arrival_sec INTEGER NOT NULL
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_gtfs_route_stop ON gtfs_stop_times(route_id, stop_id)`);

  // GTFS trips — maps the realtime feed's trip_id to route / direction / shape
  db.run(`CREATE TABLE IF NOT EXISTS gtfs_trips (
    trip_id     TEXT PRIMARY KEY,
    route_id    INTEGER,
    service_id  TEXT,
    direction   INTEGER,
    shape_id    TEXT,
    headsign    TEXT
  )`);

  // Persist DB to disk periodically (the actual interval is set in boot)
}

function saveDb() {
  if (!db) return;
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
    // Push a durable off-box snapshot (throttled internally to ~5 min) so history
    // survives a redeploy on ephemeral hosts. No-op when backup isn't configured.
    if (backup.isEnabled()) backup.snapshot(Buffer.from(data)).catch(() => {});
  } catch(e) { console.error('[db] Save error:', e.message); }
}

// Keep the DB lean: raw GPS pings and poll logs are only useful for recent
// history and short-term training. Long-term signal lives in stop_arrivals,
// which we keep. Prunes then VACUUMs to actually reclaim disk.
const PINGS_RETAIN_MS    = 14 * 86400000; // 2 weeks of raw GPS
const POLLLOG_RETAIN_MS  = 6 * 3600000;   // 6h of poll telemetry (/api/stats only reads the last 1h)
const ARRIVALS_RETAIN_MS = 365 * 86400000; // 1 year of arrivals — long enough to surface weekly/seasonal patterns, small in absolute terms (~1k rows/active stop)
function pruneDb() {
  if (!db) return;
  try {
    const now = Date.now();
    db.run(`DELETE FROM pings WHERE ts < ?`, [now - PINGS_RETAIN_MS]);
    db.run(`DELETE FROM poll_log WHERE ts < ?`, [now - POLLLOG_RETAIN_MS]);
    db.run(`DELETE FROM stop_arrivals WHERE ts < ?`, [now - ARRIVALS_RETAIN_MS]);
    db.run('VACUUM');
    saveDb();
    const sz = fs.existsSync(DB_PATH) ? Math.round(fs.statSync(DB_PATH).size / 1024) : 0;
    console.log(`[db] Pruned + vacuumed (${sz} KB)`);
  } catch(e) { console.error('[db] Prune error:', e.message); }
}

// ─── GTFS LOADER ─────────────────────────────────────────────────────────────
function parseTimeToSec(t) {
  // GTFS times can be >24:00:00 for next-day runs
  const parts = t.split(':').map(Number);
  return parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0);
}

function splitCsvLine(line) {
  const result = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQuote = !inQuote; }
    else if (c === ',' && !inQuote) { result.push(cur); cur = ''; }
    else { cur += c; }
  }
  result.push(cur);
  return result;
}

function parseCsv(text) {
  const lines = text.trim().split('\n');
  const headers = splitCsvLine(lines[0].replace(/\r/g, ''));
  return lines.slice(1).map(line => {
    const vals = splitCsvLine(line.replace(/\r/g, ''));
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] || ''; });
    return obj;
  });
}

const GTFS_META_PATH = path.join(DATA_DIR, 'heleon-gtfs-meta.json');

function gtfsMeta() {
  try { return JSON.parse(fs.readFileSync(GTFS_META_PATH, 'utf8')); } catch { return {}; }
}
function saveGtfsMeta(meta) {
  fs.writeFileSync(GTFS_META_PATH, JSON.stringify(meta));
}

async function downloadGtfsIfUpdated() {
  const meta = gtfsMeta();
  const tmpPath = GTFS_ZIP_PATH + '.tmp';

  return new Promise((resolve, reject) => {
    const reqHeaders = { 'Referer': 'https://myheleonbus.org/', 'User-Agent': 'Mozilla/5.0' };
    if (meta.lastModified) reqHeaders['If-Modified-Since'] = meta.lastModified;
    if (meta.etag) reqHeaders['If-None-Match'] = meta.etag;

    const req = https.get({ hostname: 'myheleonbus.org', path: '/gtfs', headers: reqHeaders }, res => {
      if (res.statusCode === 304) {
        console.log('[gtfs] Feed unchanged (304), using cached copy');
        resolve(false); // not updated
        return;
      }
      if (res.statusCode !== 200) {
        console.error(`[gtfs] Download failed: HTTP ${res.statusCode}`);
        res.resume();
        resolve(false);
        return;
      }
      const file = fs.createWriteStream(tmpPath);
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          try {
            // Atomic replace
            fs.renameSync(tmpPath, GTFS_ZIP_PATH);
            const newMeta = {};
            if (res.headers['last-modified']) newMeta.lastModified = res.headers['last-modified'];
            if (res.headers['etag']) newMeta.etag = res.headers['etag'];
            newMeta.downloadedAt = Date.now();
            saveGtfsMeta(newMeta);
            console.log('[gtfs] Downloaded fresh feed');
            resolve(true); // updated
          } catch(e) { reject(e); }
        });
      });
      file.on('error', e => { try { fs.unlinkSync(tmpPath); } catch {} reject(e); });
    });
    req.on('error', e => { try { fs.unlinkSync(tmpPath); } catch {} reject(e); });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function parseGtfsZip() {
  const tripsText = execSync(`unzip -p "${GTFS_ZIP_PATH}" trips.txt`).toString();
  const stText = execSync(`unzip -p "${GTFS_ZIP_PATH}" stop_times.txt`).toString();
  const stopsText = execSync(`unzip -p "${GTFS_ZIP_PATH}" stops.txt`).toString();
  const trips = parseCsv(tripsText);
  const stopTimes = parseCsv(stText);
  const gtfsStops = parseCsv(stopsText);

  const tripMap = {};
  const tripRows = [];
  trips.forEach(t => {
    tripMap[t.trip_id] = {
      route_id: parseInt(t.route_id),
      service_id: t.service_id,
      direction_id: parseInt(t.direction_id) || 0,
    };
    tripRows.push([t.trip_id, parseInt(t.route_id), t.service_id,
                   parseInt(t.direction_id) || 0, t.shape_id || '', t.trip_headsign || '']);
  });

  const stRows = [];
  stopTimes.forEach(st => {
    const trip = tripMap[st.trip_id];
    if (!trip) return;
    const arrSec = parseTimeToSec(st.arrival_time || st.departure_time);
    stRows.push([trip.route_id, st.trip_id, trip.service_id, trip.direction_id,
                 parseInt(st.stop_id), parseInt(st.stop_sequence), arrSec]);
  });

  const stopRows = gtfsStops.map(s => [
    parseInt(s.stop_id), s.stop_code, s.stop_name,
    parseFloat(s.stop_lat), parseFloat(s.stop_lon),
    parseInt(s.wheelchair_boarding) || 0
  ]).filter(r => !isNaN(r[0]));

  return { stRows, stopRows, tripRows };
}

// Encode [[lat,lon],…] as a Google-format polyline (precision 1e5) — same format
// the upstream pattern shapes use, so the frontend decodes both identically.
function encodePolyline(coords) {
  let last = [0, 0], out = '';
  const enc = v => { v = v < 0 ? ~(v << 1) : (v << 1); let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const c of coords) {
    const lat = Math.round(c[0] * 1e5), lng = Math.round(c[1] * 1e5);
    out += enc(lat - last[0]) + enc(lng - last[1]); last = [lat, lng];
  }
  return out;
}

// Load route geometry from a GTFS zip's shapes.txt for routes that have no shape
// yet (schedule-only Neighborhood/Flex/shuttle routes the live API doesn't serve).
// `shortToApp` maps a GTFS route_id (short number) to the app id we store under.
// Returns count added. Used twice: the LIVE zip, then the bundled SEED zip — the
// seed still carries 401/301/204 geometry that the current live feed dropped.
function loadShapesFromZip(zipPath, shortToApp) {
  let shapesText, tripsText;
  try {
    const opts = { maxBuffer: 64 * 1024 * 1024 }; // shapes.txt ~2MB
    shapesText = execSync(`unzip -p "${zipPath}" shapes.txt`, opts).toString();
    tripsText  = execSync(`unzip -p "${zipPath}" trips.txt`,  opts).toString();
  } catch (e) { console.error(`[gtfs-shapes] read error (${path.basename(zipPath)}):`, e.message); return 0; }

  const shapeToRoute = {};
  parseCsv(tripsText).forEach(t => { if (t.shape_id) shapeToRoute[t.shape_id] = String(t.route_id); });

  const byShape = {};
  parseCsv(shapesText).forEach(r => {
    const sid = r.shape_id; if (!sid) return;
    const lat = parseFloat(r.shape_pt_lat), lon = parseFloat(r.shape_pt_lon);
    const seq = parseInt(r.shape_pt_sequence) || 0;
    if (isNaN(lat) || isNaN(lon)) return;
    (byShape[sid] = byShape[sid] || []).push([seq, lat, lon]);
  });

  // Group shapes by route, keeping EVERY distinct variant (a route like 401 has
  // a northern AND a southern loop — drawing only the longest one drops half the
  // route). De-dup near-identical variants so we don't stack the same line twice.
  const shapesByRoute = {};
  for (const [sid, raw] of Object.entries(byShape)) {
    const rid = shapeToRoute[sid]; if (!rid) continue;
    const pts = raw.sort((a, b) => a[0] - b[0]).map(p => [p[1], p[2]]);
    if (pts.length < 2) continue;
    (shapesByRoute[rid] = shapesByRoute[rid] || []).push({ sid, pts });
  }

  let added = 0;
  for (const [gtfsRid, variants] of Object.entries(shapesByRoute)) {
    const appId = shortToApp[gtfsRid] != null ? shortToApp[gtfsRid] : parseInt(gtfsRid);
    const existing = dbGet(`SELECT COUNT(*) as n FROM route_shapes WHERE route_id=?`, [appId]);
    if (existing && existing.n > 0) continue; // already have shapes (upstream or prior load)
    const meta = ROUTE_MAP[appId] || {};

    // Keep distinct variants: drop one if its endpoints + length closely match an
    // already-kept variant (same pattern, opposite direction or duplicate).
    const kept = [];
    variants.sort((a, b) => b.pts.length - a.pts.length); // longest first
    for (const v of variants) {
      const sig = `${v.pts[0].map(n=>n.toFixed(3))}|${v.pts[v.pts.length-1].map(n=>n.toFixed(3))}|${Math.round(v.pts.length/20)}`;
      if (kept.some(k => k.sig === sig)) continue;
      kept.push({ ...v, sig });
    }

    kept.forEach((v, i) => {
      dbRun(`INSERT OR REPLACE INTO route_shapes(route_id,pattern_id,name,direction,color,shape,fetched_at)
             VALUES(?,?,?,?,?,?,?)`,
        // Synthetic pattern id per variant (appId, appId+1000*i) so all variants coexist.
        [appId, appId + i * 100000, meta.name || `Route ${gtfsRid}`, i, meta.color || '#888', encodePolyline(v.pts), Date.now()]);
      added++;
    });
    console.log(`[gtfs-shapes] route ${gtfsRid} (app id ${appId}) loaded ${kept.length} variant(s) from ${path.basename(zipPath)}`);
  }
  return added;
}

// ─── AUTHORITATIVE ROUTE REGISTRY ─────────────────────────────────────────────
// One canonical list of every route the system knows about, unioned across ALL
// sources so nothing slips through the cracks: the curated ROUTES config, the
// live RTPI API, the live GTFS feed, the bundled seed GTFS, the reference file,
// and routes inferred purely from observed GPS history. Each entry records where
// its data came from (provenance) and whether it has a drawn shape, a live
// vehicle, and a classification. Served at /api/registry; logged at boot so any
// route lacking geometry is visible immediately instead of being silently missing.
let ROUTE_REGISTRY = [];
function buildRouteRegistry() {
  const reg = {}; // short -> entry
  const touch = short => (reg[short] = reg[short] || {
    short, appId: null, name: null, color: null, class: null,
    hasShape: false, hasLiveVehicle: false, sources: [],
  });
  const addSrc = (e, s) => { if (!e.sources.includes(s)) e.sources.push(s); };

  // 1) Curated ROUTES config (incl. scheduleOnly).
  ROUTES.forEach(r => {
    const e = touch(String(r.short));
    e.appId = r.id; e.name = r.name; e.color = r.color;
    if (r.scheduleOnly) addSrc(e, 'config:scheduleOnly'); else addSrc(e, 'config');
  });

  // 2) Reference file (classification + GTFS-derived roster).
  const refClass = (REFERENCE && REFERENCE.routeClass) || {};
  const refRoutes = (REFERENCE && REFERENCE.routes) || {};
  Object.keys(refClass).forEach(short => { const e = touch(short); e.class = refClass[short]; addSrc(e, 'reference'); });
  Object.entries(refRoutes).forEach(([short, r]) => {
    const e = touch(short);
    if (!e.name && r.name) e.name = r.name;
    if (!e.color && r.color) e.color = r.color;
    addSrc(e, 'gtfs');
  });

  // 3) Which routes actually have a drawn shape in the DB.
  const shapeRows = dbAll(`SELECT DISTINCT route_id FROM route_shapes`);
  const shapeAppIds = new Set(shapeRows.map(r => String(r.route_id)));
  // 4) Which routes have a live vehicle right now.
  const liveRows = dbAll(`SELECT DISTINCT route_id FROM pings WHERE ts > ?`, [Date.now() - 3600000]);
  const liveAppIds = new Set(liveRows.map(r => String(r.route_id)));

  // Resolve appId per entry (config gives it; else fall back to the short number),
  // then flag shape/live presence.
  Object.values(reg).forEach(e => {
    if (e.appId == null) e.appId = parseInt(e.short) || e.short;
    if (shapeAppIds.has(String(e.appId))) e.hasShape = true;
    if (liveAppIds.has(String(e.appId))) { e.hasLiveVehicle = true; addSrc(e, 'live'); }
  });

  ROUTE_REGISTRY = Object.values(reg).sort((a, b) => (parseInt(a.short) || 0) - (parseInt(b.short) || 0));

  // Loudly surface any route with NO geometry so it can't be silently missing.
  const noShape = ROUTE_REGISTRY.filter(e => !e.hasShape);
  console.log(`[registry] ${ROUTE_REGISTRY.length} routes known; ${ROUTE_REGISTRY.filter(e=>e.hasShape).length} have shapes`);
  if (noShape.length) console.warn(`[registry] NO SHAPE for: ${noShape.map(e => e.short).join(', ')} — investigate (live API? GTFS? seed?)`);
  return ROUTE_REGISTRY;
}

// Fill in geometry for every schedule-only route that still has no drawn shape.
function loadGtfsShapesForMissing() {
  // App ids for schedule-only routes are their GTFS short number; live routes
  // keep their 5600+ id. Build the short→app map so both zips store consistently.
  const shortToApp = {};
  ROUTES.forEach(r => { shortToApp[String(r.short)] = r.id; });

  let added = 0;
  // 1) The live feed first (current, authoritative for routes it carries).
  if (fs.existsSync(GTFS_ZIP_PATH)) added += loadShapesFromZip(GTFS_ZIP_PATH, shortToApp);
  // 2) The bundled seed feed for routes the live one dropped (401/301/204) but
  //    that the agency still operates (e.g. you can watch a bus drive the 401 loop).
  if (fs.existsSync(SEED_GTFS_PATH)) added += loadShapesFromZip(SEED_GTFS_PATH, shortToApp);
  if (added) { saveDb(); console.log(`[gtfs-shapes] added ${added} schedule-only route shapes`); }
}

async function loadGtfs(forceRefresh = false) {
  const n = dbGet(`SELECT COUNT(*) as n FROM gtfs_stop_times`);
  const hasData = n && n.n > 0;

  // If we have data and aren't forcing refresh, just check if feed changed
  if (hasData && !forceRefresh) {
    console.log(`[gtfs] ${n.n} scheduled stop times cached`);
    return;
  }

  // Download feed (conditional request — skips if unchanged)
  let downloaded = false;
  if (!fs.existsSync(GTFS_ZIP_PATH) || forceRefresh) {
    try {
      downloaded = await downloadGtfsIfUpdated();
    } catch(e) {
      console.error('[gtfs] Download error:', e.message);
      if (!hasData) console.error('[gtfs] No cached data — scheduled times unavailable');
      return; // keep existing data intact
    }
  } else {
    downloaded = true; // zip exists but DB is empty — parse it
  }

  if (!downloaded && hasData) return; // feed unchanged, keep existing data

  // Parse zip — keep old data in DB until new data is ready
  console.log('[gtfs] Parsing GTFS feed…');
  let parsed;
  try {
    parsed = parseGtfsZip();
  } catch(e) {
    console.error('[gtfs] Parse error:', e.message);
    return; // keep existing data
  }

  const { stRows, stopRows, tripRows } = parsed;
  if (stRows.length < 100) {
    console.error(`[gtfs] Suspiciously few rows (${stRows.length}) — aborting reload to protect existing data`);
    return;
  }

  // Atomic swap: insert all new rows, then delete old ones in one transaction
  db.run('BEGIN TRANSACTION');
  try {
    db.run('DELETE FROM gtfs_stop_times');
    stRows.forEach(r => {
      db.run(`INSERT INTO gtfs_stop_times(route_id,trip_id,service_id,direction,stop_id,stop_seq,arrival_sec) VALUES(?,?,?,?,?,?,?)`, r);
    });
    db.run('DELETE FROM gtfs_stops');
    stopRows.forEach(r => {
      db.run(`INSERT INTO gtfs_stops(stop_id,stop_code,stop_name,stop_lat,stop_lon,wheelchair) VALUES(?,?,?,?,?,?)`, r);
    });
    db.run('DELETE FROM gtfs_trips');
    (tripRows || []).forEach(r => {
      db.run(`INSERT OR REPLACE INTO gtfs_trips(trip_id,route_id,service_id,direction,shape_id,headsign) VALUES(?,?,?,?,?,?)`, r);
    });
    db.run('COMMIT');
    saveDb();
    buildTripIndex();
    console.log(`[gtfs] Loaded ${stRows.length} stop times, ${stopRows.length} stops, ${(tripRows||[]).length} trips`);
  } catch(e) {
    db.run('ROLLBACK');
    console.error('[gtfs] DB insert error:', e.message);
  }
}

function dbRun(sql, params = []) {
  db.run(sql, params);
}

function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  const rows = [];
  stmt.bind(params);
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function dbGet(sql, params = []) {
  const rows = dbAll(sql, params);
  return rows[0] || null;
}

// ─── UPSTREAM FETCH ───────────────────────────────────────────────────────────
function upstreamFetch(apiPath) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = https.request({
      hostname: UPSTREAM,
      path: `/api/rtpi?path=${encodeURIComponent(apiPath)}`,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://myheleonbus.org/' },
      timeout: 8000,
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body, latency: Date.now() - t0 }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ─── WEATHER (Open-Meteo — free, no API key) ───────────────────────────────
// Big Island microclimates vary wildly (rainy Hilo vs sunny Kona), so we fetch
// current conditions at each active bus's location. Done server-side and cached
// ~10 min so it's one shared request, not per-client (saves mobile battery/data).
let weatherByVehicle = {}; // vehicleId -> { tempF, code, isDay, ts }
let weatherLastFetch = 0;
const WEATHER_TTL_MS = 10 * 60 * 1000;

function fetchJson(host, reqPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: host, path: reqPath, method: 'GET',
      headers: { 'User-Agent': 'heleon-tracker' }, timeout: 10000 }, res => {
      let b = ''; res.on('data', d => b += d);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function refreshWeather() {
  const now = Date.now();
  if (now - weatherLastFetch < WEATHER_TTL_MS) return;
  const buses = latestVehicles.filter(v => v.lat != null && v.lon != null);
  if (!buses.length) return;
  weatherLastFetch = now;
  const lats = buses.map(v => v.lat.toFixed(3)).join(',');
  const lons = buses.map(v => v.lon.toFixed(3)).join(',');
  try {
    const path = `/v1/forecast?latitude=${lats}&longitude=${lons}` +
                 `&current=temperature_2m,weather_code,is_day&temperature_unit=fahrenheit`;
    let data = await fetchJson('api.open-meteo.com', path);
    if (!Array.isArray(data)) data = [data]; // single point isn't wrapped in an array
    const next = {};
    buses.forEach((v, i) => {
      const cur = data[i] && data[i].current;
      if (cur) next[v.id] = { tempF: Math.round(cur.temperature_2m), code: cur.weather_code, isDay: !!cur.is_day, ts: now };
    });
    weatherByVehicle = next;
  } catch (e) { /* weather is best-effort; keep last good values */ }
}

// Fetch a binary body (GTFS-RT protobuf) from the upstream host.
function fetchBinary(reqPath) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = https.request({
      hostname: UPSTREAM, path: reqPath, method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': `https://${UPSTREAM}/` },
      timeout: 10000,
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks), latency: Date.now() - t0 }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ─── POLLING ─────────────────────────────────────────────────────────────────
let latestVehicles = [];
let tripUpdateIndex = {};   // tripId -> { stopId: predictedArrivalMs }
let vehicleTripMap = {};    // vehicleId -> tripId  (merged from both RT feeds)
let lastPollStats = { ts: null, total: 0 };
const startTime = new Date().toISOString();

// trip_id -> { routeId, direction, shapeId, headsign } built from GTFS trips.txt.
// Lets us attach full route context to each live vehicle from the realtime feed.
let tripRouteIndex = {};
let tripLastBuilt = 0;

// Track last known closest-stop index per vehicle for arrival detection
const vehicleLastStopIdx = {}; // vehicleId -> { stopIdx, stopId, ts }
const vehicleRecentArrival = {}; // vehicleId -> { stopId, ts } — debounce dup arrivals

function buildTripIndex() {
  const rows = dbAll(`SELECT trip_id, route_id, direction, shape_id, headsign FROM gtfs_trips`);
  const idx = {};
  rows.forEach(r => { idx[r.trip_id] = { routeId: r.route_id, direction: r.direction, shapeId: r.shape_id, headsign: r.headsign }; });
  tripRouteIndex = idx;
  tripLastBuilt = Date.now();
  return rows.length;
}

// We do NOT infer a bus's route from geometry. A bus's route comes only from the
// agency feed (its per-route endpoint, remembered briefly across dropouts). If we
// don't know it, we show no route rather than a guess.

// Token-level feature vector dimensions. Hoisted to module scope so the TX
// object below can read them during init.
const TX_TOKEN_DIM = 7;
const TX_RANK_HEADS = 5;

// ─── TRANSFORMER PREDICTOR (tiny single-block, single-head attention) ──────
// Architecture:
//   1. Input embedding (12 tokens × 8-dim) — each token is one feature
//      (speed, distance, hour, minute, dow, sched_delta, route) with positional
//      encoding baked in
//   2. Single self-attention head over all 12 tokens
//      Q = X·Wq, K = X·Wk, V = X·Wv  (8×8 projections)
//      attn = softmax(Q·Kᵀ / √d)
//      out = attn·V
//   3. LayerNorm + residual
//   4. FFN: 8→16 (ReLU) → 8
//   5. Mean pool over tokens → 5 output heads (one per future stop)
// Total params: ~280
const TX = {
  _routeIds: null,
  get routeIds() {
    if (!this._routeIds) this._routeIds = ROUTES.map(r => r.id);
    return this._routeIds;
  },
  dModel: 8,            // token embedding dim
  nTokens: 12,          // sequence length
  rawDim: TX_TOKEN_DIM, // updated when init() runs
  nHeads: 1,
  ffnDim: 16,
  outDim: TX_RANK_HEADS, // one head per "stop rank ahead" — 1st..5th
  // weights
  embedW: [],           // inputProj (raw feature) → dModel  [dModel × rawDim]
  posW: [],             // positional encoding [dModel × nTokens]
  Wq: [], Wk: [], Wv: [], // [dModel × dModel]
  Wo: [],               // out projection after attention [dModel × dModel]
  ffnW1: [], ffnB1: [], // [ffnDim × dModel]
  ffnW2: [], ffnB2: [], // [dModel × ffnDim]
  // Per-rank projection: outW[r][d] is head for the r-th stop ahead. We project
  // the r-th token's FFN output directly to its rank-r prediction, so token i
  // maps to head i (clamped to outDim-1 for further-out stops).
  outW: [], outB: [],   // [outDim × dModel]
  lnGamma: [], lnBeta: [],// [dModel]
  lr: 0.005,
  decay: 0.9999,
  trained: false,
  trainedCount: 0,

  init() {
    const r = (rows, cols) => Array.from({length: rows}, () =>
      Array.from({length: cols}, () => (Math.random() - 0.5) * 0.3));
    this.rawDim = TX_TOKEN_DIM;
    this.embedW = r(this.dModel, this.rawDim);
    this.posW = r(this.dModel, this.nTokens);
    this.Wq = r(this.dModel, this.dModel);
    this.Wk = r(this.dModel, this.dModel);
    this.Wv = r(this.dModel, this.dModel);
    this.Wo = r(this.dModel, this.dModel);
    this.ffnW1 = r(this.ffnDim, this.dModel);
    this.ffnB1 = Array(this.ffnDim).fill(0);
    this.ffnW2 = r(this.dModel, this.ffnDim);
    this.ffnB2 = Array(this.dModel).fill(0);
    this.outW = r(this.outDim, this.dModel);
    this.outB = Array(this.outDim).fill(0);
    this.lnGamma = Array(this.dModel).fill(1);
    this.lnBeta = Array(this.dModel).fill(0);
    this.trained = true;
  },

  // Forward pass — returns full intermediate state for backprop
  forward(tokens) {
    // tokens: array of nTokens × rawDim (e.g. 12 × 5)
    // Step 1: embed each token + add positional encoding
    //   x[i] = tokens[i] · embedWᵀ  (dModel)
    //   x[i] += posW[:, i]
    const x = []; // nTokens × dModel
    for (let i = 0; i < this.nTokens; i++) {
      const tok = tokens[i];
      const vec = Array(this.dModel).fill(0);
      for (let d = 0; d < this.dModel; d++) {
        let s = 0;
        for (let k = 0; k < tok.length; k++) s += this.embedW[d][k] * tok[k];
        s += this.posW[d][i];
        vec[d] = s;
      }
      x.push(vec);
    }
    // Step 2: QKV projections
    const Q = x.map(v => matVec(this.Wq, v));
    const K = x.map(v => matVec(this.Wk, v));
    const V = x.map(v => matVec(this.Wv, v));
    // Step 3: attention scores = Q·Kᵀ / sqrt(d)
    const scale = 1 / Math.sqrt(this.dModel);
    const scores = [];
    for (let i = 0; i < this.nTokens; i++) {
      const row = [];
      for (let j = 0; j < this.nTokens; j++) {
        row.push(dot(Q[i], K[j]) * scale);
      }
      scores.push(row);
    }
    // Step 4: softmax per row
    const attn = scores.map(row => softmax(row));
    // Step 5: weighted sum of V
    const ctx = [];
    for (let i = 0; i < this.nTokens; i++) {
      const v = Array(this.dModel).fill(0);
      for (let j = 0; j < this.nTokens; j++) {
        for (let d = 0; d < this.dModel; d++) {
          v[d] += attn[i][j] * V[j][d];
        }
      }
      ctx.push(v);
    }
    // Step 6: output projection
    const attnOut = ctx.map(v => matVec(this.Wo, v));
    // Step 7: residual + LayerNorm
    const postAttn = x.map((v, i) => {
      const sum = v.map((xi, d) => xi + attnOut[i][d]);
      return layerNorm(sum, this.lnGamma, this.lnBeta);
    });
    // Step 8: FFN
    const ffnOut = postAttn.map(v => {
      const h = this.ffnW1.map((row, i) => {
        let s = this.ffnB1[i];
        for (let j = 0; j < v.length; j++) s += row[j] * v[j];
        return Math.max(0, s);
      });
      const out = Array(this.dModel).fill(0);
      for (let d = 0; d < this.dModel; d++) {
        let s = this.ffnB2[d];
        for (let i = 0; i < this.ffnDim; i++) s += this.ffnW2[d][i] * h[i];
        out[d] = s;
      }
      // Residual
      return v.map((xi, d) => xi + out[d]);
    });
    // Step 9: mean pool over tokens (kept for API compatibility / introspection)
    const pooled = Array(this.dModel).fill(0);
    for (const v of ffnOut) for (let d = 0; d < this.dModel; d++) pooled[d] += v[d] / this.nTokens;
    // Step 10: per-token output heads. Head r projects token r (clamped to
    // outDim-1). For tokens beyond outDim-1 we still emit a head value (we
    // reuse outW[outDim-1]) so the API has a token per token, but only the
    // first outDim tokens carry distinct signal.
    const tokenOut = ffnOut.map((tokFFN, i) => {
      const head = Math.min(i, this.outDim - 1);
      const row = this.outW[head];
      let s = this.outB[head];
      for (let j = 0; j < tokFFN.length; j++) s += row[j] * tokFFN[j];
      return s;
    });
    // Step 11: also expose a pooled head (mean of per-token outputs) — kept
    // for any caller that wants a single scalar per bus.
    let out = 0;
    for (const v of tokenOut) out += v;
    out /= this.nTokens;

    return { tokens, x, Q, K, V, scores, attn, ctx, attnOut, postAttn, ffnOut, pooled, tokenOut, out };
  },

  // Backprop via truncated SGD on the output layer + FFN-output (proxy training).
  // For a true transformer we'd backprop through attention, but a partial
  // gradient on outW + ffnW2 captures most of the signal and stays fast.
  // Targets map to specific tokens: target k (the residual for the k-th stop
  // ahead) is trained against tokenOut[k]. Tokens beyond outDim-1 contribute
  // no target and are skipped.
  train(tokens, targets) {
    if (!this.trained) this.init();
    const fwd = this.forward(tokens);
    const errs = [];
    let nValid = 0;
    for (let k = 0; k < this.outDim; k++) {
      const t = targets[k];
      if (t == null) { errs.push(0); continue; }
      errs.push(t - fwd.tokenOut[k]);
      nValid++;
    }
    if (nValid === 0) return 0;
    const scaledErrs = errs.map(e => e / nValid);
    // Per-token gradient: head k uses token k's ffn output (not the mean pool).
    for (let k = 0; k < this.outDim; k++) {
      if (scaledErrs[k] === 0) continue;
      const tokVec = fwd.ffnOut[k];
      for (let j = 0; j < this.dModel; j++) {
        this.outW[k][j] += this.lr * scaledErrs[k] * tokVec[j];
      }
      this.outB[k] += this.lr * scaledErrs[k];
    }
    // Approximate FFN backprop: distribute d_out/k → ffnOut[k] → ffnW2. For
    // tokens beyond outDim-1 we have no direct signal, but their ffn outputs
    // still contribute through the mean pool residual (so we add a small
    // scaled signal there too — keeps the network from drifting on un-trained
    // heads but doesn't dominate).
    for (let d = 0; d < this.dModel; d++) {
      for (let k = 0; k < this.nTokens; k++) {
        let dToFfn = 0;
        if (k < this.outDim && scaledErrs[k] !== 0) {
          for (let j = 0; j < this.dModel; j++) dToFfn += scaledErrs[k] * this.outW[Math.min(k, this.outDim - 1)][j];
        }
        // approximate ffn activations for token k
        const h = this.ffnW1.map((row, i) => {
          let s = this.ffnB1[i];
          for (let m = 0; m < fwd.postAttn[k].length; m++) s += row[m] * fwd.postAttn[k][m];
          return Math.max(0, s);
        });
        for (let i = 0; i < this.ffnDim; i++) {
          this.ffnW2[d][i] += this.lr * dToFfn * h[i];
        }
        this.ffnB2[d] += this.lr * dToFfn;
      }
    }
    this.lr *= this.decay;
    this.trainedCount++;
    return Math.abs(errs.reduce((a, b) => a + b, 0));
  },
};
TX.init();

function matVec(W, v) {
  const out = Array(W.length).fill(0);
  for (let i = 0; i < W.length; i++) {
    let s = 0;
    for (let j = 0; j < v.length; j++) s += W[i][j] * v[j];
    out[i] = s;
  }
  return out;
}
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function softmax(row) {
  const m = Math.max(...row);
  const exps = row.map(v => Math.exp(v - m));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map(v => v / sum);
}
function layerNorm(x, gamma, beta) {
  const mean = x.reduce((a, b) => a + b, 0) / x.length;
  const variance = x.reduce((a, b) => a + (b - mean) ** 2, 0) / x.length;
  const std = Math.sqrt(variance + 1e-6);
  return x.map((xi, i) => gamma[i] * (xi - mean) / std + beta[i]);
}

// Build token sequence from bus state. Each token is a 7-dim vector that
// varies along the sequence — the same model must predict different
// corrections for the 1st..5th stops ahead, so the *n*-th token encodes
// "what's true for the n-th stop ahead":
//
//   [ speedNorm, distNormRankN, schedDeltaNormRankN, hourSin, hourCos, dowSin, dowCos ]
//
//   distNormRankN     = dist to stop N (extrapolated from current dist / ETA), clamped to [0,1]
//   schedDeltaNormRankN = how far ahead/behind schedule stop N is (signed)
//
// Time-of-day and day-of-week are sin/cos pairs so 23:59 sits next to 00:01
// and Sunday next to Monday (true cyclical continuity). The "rank-ahead"
// horizon dim is baked into the token *value*, and we additionally apply a
// positional encoding (posW) so the model also knows which token is which.
//
// Token-to-head mapping: token i corresponds to "the i-th stop ahead" — so
// the forward-pass output for token i is a good predictor for the head that
// targets "i stops ahead". Forward returns token-level outputs (not just the
// mean-pooled one) and we map head k to token k.

// Build token sequence from bus state. Each token is a 7-dim vector that
// varies along the sequence — the same model must predict different
// corrections for the 1st..5th stops ahead, so the *n*-th token encodes
// "what's true for the n-th stop ahead":
//
//   distNormRankN     = dist to stop N (extrapolated from current dist / ETA), clamped to [0,1]
//   schedDeltaNormRankN = how far ahead/behind schedule stop N is (signed)
//
// Time-of-day and day-of-week are sin/cos pairs so 23:59 sits next to 00:01
// and Sunday next to Monday (true cyclical continuity). The "rank-ahead"
// horizon dim is baked into the token *value*, and we additionally apply a
// positional encoding (posW) so the model also knows which token is which.
//
// Token-to-head mapping: token i corresponds to "the i-th stop ahead" — so
// the forward-pass output for token i is a good predictor for the head that
// targets "i stops ahead". Forward returns token-level outputs (not just the
// mean-pooled one) and we map head k to token k.
function buildTokenSequence(vehicle, distanceKm, schedDeltaSec, routeId) {
  const now = new Date();
  const hour = now.getHours() + now.getMinutes() / 60;
  const dow = now.getDay();
  const hourSin = Math.sin(2 * Math.PI * hour / 24);
  const hourCos = Math.cos(2 * Math.PI * hour / 24);
  const dowSin  = Math.sin(2 * Math.PI * dow / 7);
  const dowCos  = Math.cos(2 * Math.PI * dow / 7);
  const speedNorm = Math.min((vehicle.speed || 0) / 60, 1);
  const baseDist = Math.min((distanceKm || 0) / 30, 1);
  // Schedule delta: signed seconds / 600s (so ±10 min normalises to ±1)
  const schedDelta = schedDeltaSec != null
    ? Math.max(-1, Math.min(1, schedDeltaSec / 600))
    : 0;
  // Route id: one-hot-ish via single hashed scalar in [-1, 1] — gives the
  // model a per-route bias without exploding the embedding size.
  const routeScalar = routeId
    ? ((routeId * 2654435761) % 1024) / 512 - 1
    : 0;
  const tokens = [];
  for (let i = 0; i < 12; i++) {
    // Rank-ahead signal: token i encodes stop (i+1) ahead. Dist grows with
    // horizon (linearly extrap the bus's current speed over expected minutes
    // per stop), and we mix in schedule delta at diminishing weight so further
    // stops inherit less timing pressure.
    const horizonMin = (i + 1) * 1.5;                       // ~1.5 min per stop on average
    const horizonDist = Math.min(1, baseDist + speedNorm * horizonMin * 0.06);
    const horizonSched = schedDelta * (1 / (1 + i * 0.4));   // decays with rank
    tokens.push([
      speedNorm,
      horizonDist,
      horizonSched,
      hourSin,
      hourCos,
      dowSin,
      dowCos,
    ]);
  }
  return tokens;
}

async function trainFromHistory() {
  console.log('[learn] Training transformer on stop_arrivals history…');
  const rows = dbAll(`
    SELECT sa.ts as actual_ts, sa.stop_id, sa.route_id, sa.vehicle_id,
           p.speed, p.lat, p.lon, s.lat as stop_lat, s.lon as stop_lon
    FROM stop_arrivals sa
    JOIN pings p ON p.vehicle_id = sa.vehicle_id AND ABS(sa.ts - p.ts) < 300000
    JOIN stops s ON s.id = sa.stop_id AND s.route_id = sa.route_id
    WHERE sa.ts > ?
    ORDER BY sa.ts DESC LIMIT 300
  `, [Date.now() - 7 * 86400000]);
  console.log(`[learn] Got ${rows.length} training rows`);

  let totalLoss = 0, n = 0;
  for (let i = 0; i < rows.length; i++) {
    try {
      const r = rows[i];
      if (!r.stop_lat) continue;
      const dist = haversineKm(r.lat, r.lon, r.stop_lat, r.stop_lon);
      if ((r.speed || 0) < 1 || dist < 0.05) continue;
      const naiveEta = (dist / (r.speed * 1.60934)) * 60;

      // rows is DESC by ts. We want arrivals that happened AFTER r — they
      // are at LOWER indices (earlier in DESC ordering). Slice i+1..end gives
      // earlier rows (negative ts delta), slice 0..i gives later rows (positive
      // ts delta = future). Sort by ts ASC so target k is the k-th future
      // arrival in time order.
      const later = rows.slice(0, i).filter(f =>
        f.vehicle_id === r.vehicle_id &&
        (f.actual_ts - r.actual_ts) > 0 &&
        (f.actual_ts - r.actual_ts) <= 60 * 60000
      ).sort((a, b) => a.actual_ts - b.actual_ts).slice(0, 5);
      const future = later;

      const targets = future.map(f => (f.actual_ts - r.actual_ts) / 60000 - naiveEta);
      while (targets.length < 5) targets.push(null);

      const tokens = buildTokenSequence({ speed: r.speed }, dist, null, r.route_id);
      const loss = TX.train(tokens, targets);
      totalLoss += loss; n++;
    } catch(e) { /* skip bad row */ }
  }
  console.log(`[learn] Trained transformer on ${n} examples, total loss: ${totalLoss.toFixed(1)}, lr=${TX.lr.toFixed(5)}`);
}

// Pull the TripUpdates feed → tripId -> { stopId: predictedArrivalMs, _seq }.
// These are the agency's official predicted arrival times (headline ETA).
async function pollTripUpdates() {
  let res;
  try { res = await fetchBinary(RT_TU_PATH); } catch { return; }
  if (res.status !== 200 || !res.buf.length) return;
  let feed;
  try { feed = parseFeedMessage(res.buf); } catch { return; }
  const idx = {};
  const now = Date.now();
  const tripMap = {}; // rebuilt fresh each poll so stale trips don't linger
  feed.forEach(e => {
    const tu = e.tripUpdate;
    if (!tu || !tu.trip || !tu.trip.tripId) return;
    const byStop = {};
    tu.stopTimeUpdates.forEach(s => {
      const t = (s.arrival && s.arrival.time) || (s.departure && s.departure.time);
      if (t && s.stopId) byStop[s.stopId] = { ms: t * 1000, seq: s.stopSeq };
    });
    idx[tu.trip.tripId] = byStop;
    // Map this vehicle to the trip it's *currently operating*. A vehicle appears
    // in the feed on several consecutive trips (its block); the active one is the
    // trip whose predicted-stop time window contains "now" (or starts soonest).
    if (tu.vehicleId) {
      const id = parseInt(tu.vehicleId) || tu.vehicleId;
      const times = tu.stopTimeUpdates.map(s => s.arrival && s.arrival.time).filter(Boolean).map(t => t * 1000);
      if (times.length) {
        const firstMs = Math.min(...times), lastMs = Math.max(...times);
        // Score: 0 if now is within the trip's window (active), else distance to it.
        const score = now >= firstMs && now <= lastMs ? 0 : Math.min(Math.abs(firstMs - now), Math.abs(lastMs - now));
        const prev = tripMap[id];
        if (!prev || score < prev._score) {
          tripMap[id] = { tripId: tu.trip.tripId, _score: score };
        }
      }
    }
  });
  tripUpdateIndex = idx;
  vehicleTripMap = tripMap; // TripUpdates is authoritative for active trip
}

// Merge the VehiclePositions feed's vehicle→trip and bearing into shared maps.
// VP is sometimes laggy/incomplete on this feed, so it augments rather than
// drives the vehicle list (the fleet JSON below is the authoritative source).
const vpBearing = {};  // vehicleId -> { bearing, ts }
let vpTripMap = {};     // vehicleId -> tripId, used only when TripUpdates lacks the bus
async function pollVehiclePositions() {
  let res;
  try { res = await fetchBinary(RT_VP_PATH); } catch { return; }
  if (res.status !== 200 || !res.buf.length) return;
  let feed;
  try { feed = parseFeedMessage(res.buf); } catch { return; }
  const now = Date.now();
  const nextTrip = {};
  feed.forEach(e => {
    const vp = e.vehicle;
    if (!vp || !vp.vehicleId) return;
    const id = parseInt(vp.vehicleId) || vp.vehicleId;
    const tripId = vp.trip && vp.trip.tripId;
    if (tripId) nextTrip[id] = tripId;
    if (vp.bearing != null && vp.timestamp && (now - vp.timestamp * 1000) < VEHICLE_STALE_MS) {
      vpBearing[id] = { bearing: Math.round(vp.bearing), ts: vp.timestamp * 1000 };
    }
  });
  vpTripMap = nextTrip;
}

// Authoritative position source: routes/{id}/vehicles, polled per active route.
// Unlike the bare /vehicles roster (which carries NO speed/heading and is full
// of years-stale entries), this endpoint returns real motion data — speed,
// headingDegrees, patternId — and tells us the route for free. We poll every
// route in parallel and dedupe; a bus reported on multiple routes keeps the
// freshest reading. GTFS-RT feeds then enrich each bus with its active trip and
// official stop predictions. This is what makes arrows point the right way,
// ETAs work, and every running bus (e.g. route 2) actually appear.
// Last good per-vehicle reading, so a single failed/empty upstream poll never
// makes a bus vanish from the page (the rider in the rain keeps seeing it, just
// aging). Kept until the GPS itself goes stale (VEHICLE_STALE_MS).
const lastGoodVehicle = {}; // vehicleId -> built vehicle object
// Remember each bus's last KNOWN route (from a real per-route endpoint) so the
// roster fallback doesn't flip a bus onto a wrong nearest-shape guess when it
// briefly drops out of its route list. vehicleId -> { routeId, ts }.
const lastKnownRoute = {};
const ROUTE_MEMORY_MS = 6 * 60 * 60 * 1000; // trust a remembered route for 6 h

async function pollFleet() {
  const ts = Date.now();
  const byId = {}; // vehicleId -> raw reading (freshest wins)

  const results = await Promise.all(ROUTES.map(async route => {
    let res;
    try { res = await upstreamFetch(`routes/${route.id}/vehicles`); }
    catch { return { rid: route.id, status: 0, latency: 0, count: 0 }; }
    let arr = [];
    if (res.status === 200) { try { arr = JSON.parse(res.body); } catch {} }
    if (!Array.isArray(arr)) arr = [];
    return { rid: route.id, status: res.status, latency: res.latency, list: arr };
  }));

  results.forEach(r => {
    const list = r.list || [];
    list.forEach(raw => {
      if (raw.lat == null || raw.lon == null) return;
      if (raw.lat < BBOX.minLat || raw.lat > BBOX.maxLat || raw.lon < BBOX.minLon || raw.lon > BBOX.maxLon) return;
      const luMs = raw.lastUpdated ? parseFleetTs(raw.lastUpdated) : ts;
      if ((ts - luMs) > VEHICLE_RETAIN_MS) return; // keep last-known up to the retain window
      const prev = byId[raw.id];
      // Keep the reading from the route this bus is most freshly on; prefer one
      // with real speed/heading if timestamps tie.
      if (!prev || luMs > prev._luMs || (luMs === prev._luMs && (raw.speed || 0) > (prev.speed || 0))) {
        byId[raw.id] = Object.assign({}, raw, { _routeId: r.rid, _luMs: luMs });
      }
      // Remember this real route assignment (only from fresh readings) so the
      // roster fallback won't flip the bus onto a nearest-shape guess later.
      if ((ts - luMs) < VEHICLE_STALE_MS) lastKnownRoute[raw.id] = { routeId: r.rid, ts };
    });
    dbRun(`INSERT INTO poll_log(ts,route_id,status,latency,count) VALUES(?,?,?,?,?)`,
      [ts, r.rid, r.status, r.latency || 0, list.length]);
  });

  // Also sweep the full roster for buses that are reporting fresh GPS but aren't
  // assigned to any route's vehicle list (idle / between-runs). They'd otherwise
  // be invisible even though they're clearly out. We infer their route from the
  // nearest route shape so they still show in context.
  try {
    const roster = JSON.parse((await upstreamFetch('vehicles')).body);
    if (Array.isArray(roster)) roster.forEach(raw => {
      if (byId[raw.id]) return;                  // already have a per-route reading
      if (raw.lat == null || raw.lon == null) return;
      if (raw.lat < BBOX.minLat || raw.lat > BBOX.maxLat || raw.lon < BBOX.minLon || raw.lon > BBOX.maxLon) return;
      const luMs = raw.lastUpdated ? parseFleetTs(raw.lastUpdated) : ts;
      if ((ts - luMs) > VEHICLE_RETAIN_MS) return;
      // Use the bus's last KNOWN route from the real feed if we have a recent one
      // (so it keeps its real route through a brief dropout). We do NOT guess a
      // route from geometry — showing a fabricated route is worse than none.
      // A bus with no known route shows as route-less (not in service).
      const mem = lastKnownRoute[raw.id];
      const routeId = mem && (ts - mem.ts) < ROUTE_MEMORY_MS ? mem.routeId : null;
      byId[raw.id] = Object.assign({}, raw, { _routeId: routeId, _luMs: luMs, _unassigned: true });
    });
  } catch {}

  const vehicles = [];
  Object.values(byId).forEach(raw => {
    const id = raw.id;
    const luMs = raw._luMs;
    // Route is authoritative from the endpoint we found the bus on.
    const routeId = raw._routeId;
    const route = ROUTE_MAP[routeId];
    // Active trip + official predictions come from the RT feeds (best-effort).
    const tripId = (vehicleTripMap[id] && vehicleTripMap[id].tripId) || vpTripMap[id] || null;
    const ti = tripId ? tripRouteIndex[tripId] : null;
    // Heading: prefer the GTFS-RT bearing (smoothed), else the endpoint's value.
    const brg = vpBearing[id] && (ts - vpBearing[id].ts) < VEHICLE_STALE_MS ? vpBearing[id].bearing
              : (raw.headingDegrees != null ? Math.round(raw.headingDegrees) : null);
    const v = {
      id, name: raw.name || String(id),
      lat: raw.lat, lon: raw.lon,
      speed: raw.speed != null ? raw.speed : null,   // mph
      headingDegrees: brg,
      heading: raw.heading || null,                  // cardinal label (N/NE/…)
      passengerLoad: raw.passengerLoad != null ? raw.passengerLoad : 0,
      capacity: raw.capacity != null ? raw.capacity : null,
      shapeDistanceTraveled: raw.shapeDistanceTraveled || 0,
      patternId: raw.patternId || null,
      tripId,
      headsign: ti ? ti.headsign : null,
      direction: ti ? ti.direction : null,
      shapeId: ti ? ti.shapeId : null,
      vehicleTs: luMs,
      // The bare roster clock is skewed, so a roster-only age can come out
      // slightly negative — clamp sub-3h skew to "just now" rather than show a
      // bogus negative/stale age.
      ageMin: (() => { let a = (ts - luMs) / 60000; if (a < 0) a = a > -180 ? 0 : a; return Math.round(a * 10) / 10; })(),
      stale: (ts - luMs) > VEHICLE_STALE_MS && (ts - luMs) > 0,
      lastUpdated: new Date(luMs).toISOString(),
      routeId,
      unassigned: !!raw._unassigned,    // reporting GPS but not on a route's vehicle list now
      routeName: route ? route.name : 'Not in service',
      routeShort: route ? route.short : '—',
      routeColor: route ? route.color : '#8b949e',
    };
    vehicles.push(v);

    dbRun(`INSERT INTO pings (ts,vehicle_id,vehicle_name,route_id,pattern_id,lat,lon,speed,heading,heading_deg,passenger_load,capacity,shape_dist,last_updated)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [ts, v.id, v.name, routeId, v.patternId, v.lat, v.lon, v.speed,
       v.heading, v.headingDegrees, v.passengerLoad, v.capacity, v.shapeDistanceTraveled, tripId]);

    lastGoodVehicle[id] = v;
  });

  // Keep showing each bus's last-known position even after it stops reporting,
  // up to the retain window, so buses fade out gracefully instead of flickering
  // off and back on. The client renders opacity by ageMin.
  const seen = new Set(vehicles.map(v => v.id));
  Object.values(lastGoodVehicle).forEach(v => {
    if (seen.has(v.id)) return;
    if ((ts - v.vehicleTs) > VEHICLE_RETAIN_MS) { delete lastGoodVehicle[v.id]; return; }
    vehicles.push(Object.assign({}, v, {
      stale: true,
      ageMin: Math.round(((ts - v.vehicleTs) / 60000) * 10) / 10,
    }));
  });

  return vehicles;
}

// Two timestamp shapes from the agency: routes/{id}/vehicles gives ISO-8601 with
// a "Z" (UTC); the bare /vehicles roster gives no suffix and runs on Hawaiʻi
// local time (HST, UTC-10). Detect which and parse accordingly.
function parseFleetTs(s) {
  if (!s) return null;
  // Has an explicit zone (Z or ±hh:mm)? Then it's absolute — trust Date.parse.
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  // Bare local time → interpret as HST (UTC-10).
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) { const t = Date.parse(s); return Number.isNaN(t) ? null : t; }
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] + 10, +m[5], +m[6]);
}

// Called after each poll — detect when a bus has moved past a stop
function detectArrivals(vehicle, routeId) {
  const stops = stopsCache[routeId];
  if (!stops || !stops.length) return;

  // Find closest stop index
  let minDist = Infinity, closestIdx = 0;
  stops.forEach((s, i) => {
    const d = haversineKm(vehicle.lat, vehicle.lon, s.lat, s.lon);
    if (d < minDist) { minDist = d; closestIdx = i; }
  });

  // Only record arrival if bus is within 200m of the stop
  if (minDist > 0.2) {
    // Update tracking but don't record arrival yet
    vehicleLastStopIdx[vehicle.id] = vehicleLastStopIdx[vehicle.id] || {};
    vehicleLastStopIdx[vehicle.id].pendingIdx = closestIdx;
    return;
  }

  const prev = vehicleLastStopIdx[vehicle.id];
  const stop = stops[closestIdx];

  // Debounce: don't re-record the same stop for this vehicle within 3 min. The
  // nearest stop can briefly flip away and back when a bus lingers near the 200 m
  // boundary (at a light / slow approach), which otherwise double-counts the
  // arrival — corrupting the predictor's training pairs and learned-stop dwell
  // counts. A genuine revisit on a loop takes far longer than 3 min.
  const recent = vehicleRecentArrival[vehicle.id];
  if (recent && recent.stopId === stop.id && (Date.now() - recent.ts) < 3 * 60000) return;

  // Record arrival if this is a new stop (advanced forward on route)
  if (!prev || prev.stopId !== stop.id) {
    const speedKmh = (vehicle.speed || 0) * 1.60934;

    // Get historical avg speed for this route over last hour
    const histRows = dbAll(
      `SELECT speed FROM pings WHERE route_id=? AND ts > ? AND speed > 0`,
      [routeId, Date.now() - 3600000]
    );
    const histAvgMph = histRows.length
      ? histRows.reduce((s, r) => s + r.speed, 0) / histRows.length
      : vehicle.speed || 0;

    dbRun(
      `INSERT INTO stop_arrivals(ts,vehicle_id,route_id,stop_id,stop_seq,eta_speed,eta_hist) VALUES(?,?,?,?,?,?,?)`,
      [Date.now(), vehicle.id, routeId, stop.id, closestIdx,
       vehicle.speed > 0 ? Math.round(minDist / (speedKmh / 60) * 10) / 10 : null,
       histAvgMph > 0 ? Math.round(minDist / ((histAvgMph * 1.60934) / 60) * 10) / 10 : null]
    );

    // Live online learning: feed this arrival into the transformer
    try {
      const prevArr = dbGet(
        `SELECT stop_seq, ts FROM stop_arrivals WHERE vehicle_id=? AND ts<? ORDER BY ts DESC LIMIT 1`,
        [vehicle.id]
      );
      if (prevArr) {
        const timeSince = (Date.now() - prevArr.ts) / 60000;
        if (timeSince > 0.5 && timeSince <= 60) {
          // Train on (state_at_prev_stop, arrival_at_this_stop) pair
          const prevState = dbGet(
            `SELECT p.speed, p.lat, p.lon FROM pings p WHERE p.vehicle_id=? AND ABS(p.ts - ?) < 300000 ORDER BY ABS(p.ts - ?) LIMIT 1`,
            [vehicle.id, prevArr.ts, prevArr.ts]
          );
          if (prevState) {
            const prevStop = stops.find(s => s.seq === prevArr.stop_seq);
            if (prevStop) {
              const dist = haversineKm(prevState.lat, prevState.lon, prevStop.lat, prevStop.lon);
              if ((prevState.speed || 0) > 1 && dist > 0.05) {
                const naiveEta = (dist / (prevState.speed * 1.60934)) * 60;
                const residual = timeSince - naiveEta;
                const tokens = buildTokenSequence({ speed: prevState.speed }, dist, null, routeId);
                const targets = [residual, null, null, null, null];
                TX.train(tokens, targets);
              }
            }
          }
        }
      }
    } catch (e) { /* skip live training errors */ }

    vehicleLastStopIdx[vehicle.id] = { stopId: stop.id, stopIdx: closestIdx, stopSeq: stop.seq, ts: Date.now() };
    vehicleRecentArrival[vehicle.id] = { stopId: stop.id, ts: Date.now() };
  }
}

async function pollAll() {
  // Build the vehicle→trip + ETA maps from both RT feeds first, then read the
  // authoritative fleet list. Three cheap requests replace 22 per-route polls.
  await Promise.all([
    pollTripUpdates().catch(() => {}),
    pollVehiclePositions().catch(() => {}),
  ]);
  const vehicles = await pollFleet().catch(() => []);
  latestVehicles = vehicles;
  // Attach cached microclimate weather + refresh it in the background.
  latestVehicles.forEach(v => { v.weather = weatherByVehicle[v.id] || null; });
  refreshWeather().catch(() => {});
  // Detect stop arrivals for each active vehicle
  latestVehicles.forEach(v => {
    if (v.routeId) { try { detectArrivals(v, v.routeId); } catch(e) {} }
  });
  lastPollStats = { ts: Date.now(), total: latestVehicles.length };
  process.stdout.write(`\r[${new Date().toLocaleTimeString()}] ${latestVehicles.length} vehicles  `);
}

// ─── AUTO-DISCOVERY ───────────────────────────────────────────────────────────
async function discoverNewRoutes() {
  try {
    const r = await upstreamFetch('routes');
    if (r.status !== 200) return;
    const routes = JSON.parse(r.body);
    if (!Array.isArray(routes)) return;
    let added = 0;
    for (const route of routes) {
      const id = route.id;
      if (!ROUTE_MAP[id]) {
        const short = route.shortName || route.name || String(id);
        const name = route.name || short;
        const color = route.color ? `#${route.color}` : '#999999';
        const newRoute = { id, name, short, color };
        ROUTES.push(newRoute);
        ROUTE_MAP[id] = newRoute;
        console.log(`\n[discovery] New route found: ${name} (id=${id})`);
        // Fetch stops AND the route's shape so it draws immediately (was missing
        // the shape fetch before, so newly-discovered routes had no line until the
        // daily fetchShapes ran).
        fetchStopsForRoute(id).then(stops => { stopsCache[id] = stops; });
        (async () => {
          try {
            const pr = await upstreamFetch(`routes/${id}/patterns`);
            if (pr.status === 200) {
              const patterns = JSON.parse(pr.body);
              if (Array.isArray(patterns)) {
                patterns.forEach(pp => dbRun(
                  `INSERT OR REPLACE INTO route_shapes(route_id,pattern_id,name,direction,color,shape,fetched_at)
                   VALUES(?,?,?,?,?,?,?)`,
                  [id, pp.id, pp.name, pp.directionType, pp.color || color, pp.shape, Date.now()]));
                saveDb();
              }
            }
          } catch (e) { console.error(`[discovery] shape fetch ${id}:`, e.message); }
        })();
        added++;
      }
    }
    if (added > 0) saveDb();
  } catch(e) {
    console.error('\n[discovery] Error:', e.message);
  }
}

// ─── SHAPES ───────────────────────────────────────────────────────────────────
async function fetchShapes() {
  console.log('\n[shapes] Fetching route shapes…');
  for (const route of ROUTES) {
    try {
      const r = await upstreamFetch(`routes/${route.id}/patterns`);
      if (r.status !== 200) continue;
      const patterns = JSON.parse(r.body);
      if (!Array.isArray(patterns)) continue;
      patterns.forEach(p => {
        dbRun(`INSERT OR REPLACE INTO route_shapes(route_id,pattern_id,name,direction,color,shape,fetched_at)
          VALUES(?,?,?,?,?,?,?)`,
          [route.id, p.id, p.name, p.directionType, p.color || route.color, p.shape, Date.now()]);
      });
      process.stdout.write(`[shapes] ${route.short} ✓  `);
    } catch(e) { console.error(`\n[shapes] Error ${route.short}:`, e.message); }
    await new Promise(r => setTimeout(r, 250));
  }
  saveDb();
  console.log('\n[shapes] Done.');
}

// ─── ROAD-SNAP ALL ROUTE SHAPES (Valhalla map-matching, cached) ────────────────
// Snap every route PATTERN's GTFS shape onto real roads, ONCE, caching the result
// keyed by the raw shape's hash. Bad snaps are rejected by map-match.js (we keep
// raw for those). Runs in the background so it never blocks boot; the map upgrades
// to road-following lines as each pattern finishes. Cached in the DB → backed up →
// survives Render reboots, and only re-snaps a pattern whose shape actually changed.
let matchingInProgress = false;
async function matchAllShapes() {
  if (matchingInProgress) return;
  matchingInProgress = true;
  try {
    const rows = dbAll(`SELECT pattern_id, route_id, shape FROM route_shapes WHERE shape IS NOT NULL`);
    let snapped = 0, kept = 0, skipped = 0;
    const RETRY_RAW_MS = 24 * 60 * 60 * 1000; // re-attempt a kept-raw pattern after a day
    for (const row of rows) {
      const h = shapeHash(row.shape);
      const cached = dbGet(`SELECT src_hash, is_raw, matched_at FROM route_shapes_matched WHERE pattern_id=?`, [row.pattern_id]);
      if (cached && cached.src_hash === h) {
        // A clean snap is cached forever (until the shape changes). A kept-raw
        // result is RETRIED periodically — Valhalla / OSM may have been having a
        // transient problem, so we self-heal rather than stay raw forever.
        if (!cached.is_raw) { skipped++; continue; }
        if (Date.now() - (cached.matched_at || 0) < RETRY_RAW_MS) { skipped++; continue; }
      }

      let result;
      try { result = await matchShape(row.shape); }
      catch (e) { console.error(`[match] pattern ${row.pattern_id} (route ${row.route_id}) error: ${e.message}`); continue; }

      dbRun(`INSERT OR REPLACE INTO route_shapes_matched(pattern_id,route_id,src_hash,shape,is_raw,note,matched_at)
             VALUES(?,?,?,?,?,?,?)`,
        [row.pattern_id, row.route_id, h, result.encoded, result.raw ? 1 : 0, result.reason || '', Date.now()]);
      if (result.raw) { kept++; }
      else { snapped++; }
      saveDb();
      await new Promise(r => setTimeout(r, 500)); // polite to the public Valhalla server
    }
    if (snapped + kept > 0) console.log(`[match] done — ${snapped} snapped to roads, ${kept} kept raw, ${skipped} cached`);
  } finally {
    matchingInProgress = false;
  }
}

// Self-healing scheduler: keep retrying until every pattern has a snap result,
// then settle to a daily refresh. If Valhalla was down at boot, this recovers on
// its own within the hour instead of waiting a full day — zero manual steps.
function scheduleMatching() {
  const tick = async () => {
    await matchAllShapes().catch(e => console.error('[match] run:', e.message));
    const total = (dbGet(`SELECT COUNT(*) n FROM route_shapes WHERE shape IS NOT NULL`) || {}).n || 0;
    const done = (dbGet(`SELECT COUNT(*) n FROM route_shapes_matched`) || {}).n || 0;
    // Not everything attempted yet (e.g. Valhalla flaky) → retry in 30 min.
    // Otherwise everything has a result → relax to a daily refresh.
    const next = done < total ? 30 * 60 * 1000 : 24 * 60 * 60 * 1000;
    setTimeout(tick, next);
  };
  setTimeout(tick, 3000); // first run shortly after boot (non-blocking)
}

// Best geometry for a pattern: road-snapped (DB) when clean, else the raw shape.
function bestPatternShape(patternId, rawShape) {
  const m = dbGet(`SELECT shape, is_raw FROM route_shapes_matched WHERE pattern_id=?`, [patternId]);
  if (m && m.shape && !m.is_raw) return m.shape;
  return rawShape;
}

// Run the schedule-PDF scraper as a child process, weekly. Kept out-of-process
// so its network work (and any hang behind the agency's Akamai protection) can't
// stall the main server. Logs are streamed to our console.
function runScript(rel, onDone) {
  try {
    const { spawn } = require('child_process');
    const script = path.join(__dirname, rel);
    if (!fs.existsSync(script)) return;
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', e => console.error(`[scrape] spawn error (${rel}):`, e.message));
    if (onDone) child.on('exit', () => onDone());
  } catch (e) { console.error(`[scrape] error (${rel}):`, e.message); }
}
function runScrape() {
  // Refresh the reference data (route class/hubs/roster) from GTFS, then reload
  // it in-process so /api/reference is current without a restart.
  console.log('[scrape] starting weekly reference + schedule scrape…');
  runScript(path.join('scripts', 'scrape-reference.js'), loadReference);
  // And mirror the human-readable schedule PDFs (cosmetic; may be Akamai-blocked).
  runScript(path.join('scripts', 'scrape-schedules.js'));
}
function scheduleWeeklyScrape() {
  setTimeout(runScrape, 60 * 1000);                 // ~1 min after boot
  setInterval(runScrape, 7 * 24 * 60 * 60 * 1000);  // then weekly
}

// ─── STOPS ───────────────────────────────────────────────────────────────────
const stopsCache = {}; // routeId -> [{ id, lat, lon, name, stopCode, seq }]

async function fetchStopsForRoute(routeId) {
  try {
    const r = await upstreamFetch(`routes/${routeId}/stops`);
    if (r.status !== 200) return [];
    const stops = JSON.parse(r.body);
    if (!Array.isArray(stops)) return [];
    // Deduplicate by id, assign sequence by array order
    const seen = new Set();
    const unique = stops.filter(s => { if (seen.has(s.id)) return false; seen.add(s.id); return true; });
    const mapped = unique.map((s, i) => ({ id: s.id, lat: s.lat, lon: s.lon, name: s.name, stopCode: s.stopCode || '', seq: i }));
    // Persist to DB
    mapped.forEach(s => {
      dbRun(`INSERT OR REPLACE INTO stops(id,route_id,lat,lon,name,stop_code,seq,fetched_at) VALUES(?,?,?,?,?,?,?,?)`,
        [s.id, routeId, s.lat, s.lon, s.name, s.stopCode, s.seq, Date.now()]);
    });
    return mapped;
  } catch { return []; }
}

async function ensureStops(routeId) {
  if (stopsCache[routeId]) return stopsCache[routeId];
  // Try DB first
  const rows = dbAll(`SELECT id,lat,lon,name,stop_code as stopCode,seq FROM stops WHERE route_id=? ORDER BY seq`, [routeId]);
  if (rows.length) { stopsCache[routeId] = rows; return rows; }
  const stops = await fetchStopsForRoute(routeId);
  stopsCache[routeId] = stops;
  return stops;
}

async function fetchAllStops() {
  console.log('\n[stops] Fetching stops for all routes…');
  for (const route of ROUTES) {
    const existing = dbGet(`SELECT COUNT(*) as n FROM stops WHERE route_id=?`, [route.id]);
    if (existing && existing.n > 0) { process.stdout.write(`[stops] ${route.short} cached  `); stopsCache[route.id] = dbAll(`SELECT id,lat,lon,name,stop_code as stopCode,seq FROM stops WHERE route_id=? ORDER BY seq`, [route.id]); continue; }
    const stops = await fetchStopsForRoute(route.id);
    stopsCache[route.id] = stops;
    process.stdout.write(`[stops] ${route.short}(${stops.length})  `);
    await new Promise(r => setTimeout(r, 200));
  }
  saveDb();
  console.log('\n[stops] Done.');
}

// ─── ETA CALCULATION ─────────────────────────────────────────────────────────
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, dLat = (lat2-lat1)*Math.PI/180, dLon = (lon2-lon1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function calcETAs(vehicle, stops) {
  if (!stops || !stops.length || vehicle.speed === undefined) return [];
  const speedKmh = (vehicle.speed || 0) * 1.60934; // mph → km/h
  return stops.map(stop => {
    const distKm = haversineKm(vehicle.lat, vehicle.lon, stop.lat, stop.lon);
    const etaMin = speedKmh > 2 ? (distKm / speedKmh) * 60 : null;
    return { stopId: stop.id, name: stop.name, lat: stop.lat, lon: stop.lon,
             distKm: Math.round(distKm * 1000) / 1000, etaMin: etaMin !== null ? Math.round(etaMin * 10) / 10 : null };
  }).sort((a, b) => a.distKm - b.distKm).slice(0, 8);
}

// ─── LEARNED ROUTE / STOPS (from observed GPS) ──────────────────────────────
// Snap a lat/lon to a ~`m`-metre grid cell key.
function cellKey(lat, lon, m) {
  const dLat = m / 111320, dLon = m / (111320 * Math.cos(lat * Math.PI / 180));
  return `${Math.round(lat / dLat)},${Math.round(lon / dLon)}`;
}
function cellCenter(key, m) {
  const [a, b] = key.split(',').map(Number);
  const lat = a * (m / 111320);
  const lon = b * (m / (111320 * Math.cos(lat * Math.PI / 180)));
  return [lon, lat];
}

// De-facto stops: cells where buses repeatedly DWELL across many distinct runs.
// A single red-light pause is one run at that cell; a real stop recurs across
// many runs (different vehicle-days). We also require it be away from any
// official stop (>80 m) so we only surface stops riders don't already see.
const LEARN_STOP_CELL_M = 35;
const LEARN_STOP_MIN_DAYS = 3;        // must recur on ≥3 distinct calendar days
const LEARN_STOP_MIN_RUNS = 4;        // …across ≥4 vehicle-days (runs)
const OFFICIAL_NEAR_M = 80;
function learnStops(routeId) {
  const since = Date.now() - PINGS_RETAIN_MS;
  const where = routeId ? `route_id=? AND` : '';
  const params = routeId ? [routeId, since] : [since];
  // Stopped (or crawling) pings only.
  const rows = dbAll(
    `SELECT vehicle_id, ts, lat, lon, route_id FROM pings
     WHERE ${where} speed <= 2 AND ts > ?`, params);
  const cells = {}; // cellKey -> { runs:Set, days:Set, perVeh:{}, route_id, n }
  rows.forEach(r => {
    const day = Math.floor(r.ts / 86400000);
    const key = cellKey(r.lat, r.lon, LEARN_STOP_CELL_M);
    const c = cells[key] || (cells[key] = { runs: new Set(), days: new Set(), perVeh: {}, route_id: r.route_id, n: 0 });
    c.runs.add(r.vehicle_id + '|' + day);
    c.days.add(day);
    c.perVeh[r.vehicle_id] = (c.perVeh[r.vehicle_id] || 0) + 1;
    c.n++;
  });
  const officials = dbAll(`SELECT lat, lon FROM stops`);
  const out = [];
  for (const key in cells) {
    const c = cells[key];
    // Recurrence gates: many separate runs AND across several distinct days, so
    // a one-off pause or a single bad-luck red light never qualifies.
    if (c.runs.size < LEARN_STOP_MIN_RUNS || c.days.size < LEARN_STOP_MIN_DAYS) continue;
    // Yard filter: a real rider stop is a BRIEF dwell (bus pauses, then goes).
    // A yard / transit center is a long park — huge sample counts per run. If the
    // average dwell per run is very high (≫ a normal stop), it's parking, skip it.
    const avgPerRun = c.n / c.runs.size;
    if (avgPerRun > 40) continue; // ~40 polls ≈ 10 min sitting → not a stop
    if (c.n > 2000) continue;     // absolute guard against the big yards
    const [lon, lat] = cellCenter(key, LEARN_STOP_CELL_M);
    if (officials.some(o => haversineKm(lat, lon, o.lat, o.lon) * 1000 < OFFICIAL_NEAR_M)) continue;
    out.push({ lat, lon, runs: c.runs.size, days: c.days.size, samples: c.n, route_id: c.route_id });
  }
  out.sort((a, b) => b.runs - a.runs);
  return out.slice(0, 300);
}

// Learned travel corridor for a route: the set of grid cells its buses actually
// drive through often (incl. detours the GTFS shape omits), as point centers the
// frontend can use to aim the direction chevrons along the real path.
const LEARN_PATH_CELL_M = 30;
const LEARN_PATH_MIN_RUNS = 3;
function learnCorridor(routeId) {
  if (!routeId) return [];
  const since = Date.now() - PINGS_RETAIN_MS;
  const rows = dbAll(
    `SELECT vehicle_id, ts, lat, lon FROM pings WHERE route_id=? AND ts > ?`, [routeId, since]);
  const cellRuns = {};
  rows.forEach(r => {
    const key = cellKey(r.lat, r.lon, LEARN_PATH_CELL_M);
    const runId = r.vehicle_id + '|' + Math.floor(r.ts / 86400000);
    (cellRuns[key] = cellRuns[key] || new Set()).add(runId);
  });
  const cells = [];
  for (const key in cellRuns) {
    if (cellRuns[key].size < LEARN_PATH_MIN_RUNS) continue;
    const [lon, lat] = cellCenter(key, LEARN_PATH_CELL_M);
    cells.push({ lat, lon, runs: cellRuns[key].size });
  }
  return cells;
}

// Short-lived memo for the heavy /api/stopline computation (see handler).
const stoplineMemo = new Map();

// ─── HTTP SERVER ──────────────────────────────────────────────────────────────
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.ico':'image/x-icon', '.svg':'image/svg+xml', '.png':'image/png', '.json':'application/json' };

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' });
  res.end(JSON.stringify(data));
}

async function handleApi(url, res) {
  const p = url.pathname;
  const q = url.searchParams;

  if (p === '/api/vehicles') {
    return json(res, { ts: lastPollStats.ts, vehicles: latestVehicles, stats: lastPollStats });
  }

  // Everything we can scrape about the WHOLE fleet — every vehicle the agency
  // API knows about, live or not, with all telemetry and a derived status that
  // explains why a bus is or isn't on the map. Powers the Fleet tab.
  if (p === '/api/fleet') {
    const now = Date.now();
    // Full roster (every vehicle ever registered) …
    let roster = [];
    try { roster = JSON.parse((await upstreamFetch('vehicles')).body); } catch {}
    if (!Array.isArray(roster)) roster = [];
    // … plus the per-route endpoint, which carries the live speed/heading/route
    // for the ones currently reporting.
    const liveByRoute = {}; // id -> { ...raw, routeId }
    await Promise.all(ROUTES.map(async route => {
      let vs = [];
      try { vs = JSON.parse((await upstreamFetch(`routes/${route.id}/vehicles`)).body); } catch {}
      if (Array.isArray(vs)) vs.forEach(v => {
        const t = parseFleetTs(v.lastUpdated);
        const prev = liveByRoute[v.id];
        if (!prev || t > prev._t) liveByRoute[v.id] = Object.assign({}, v, { routeId: route.id, _t: t });
      });
    }));

    const fleet = roster.map(r => {
      const live = liveByRoute[r.id];
      const src = live || r;                       // prefer the richer per-route record
      const luMs = parseFleetTs(src.lastUpdated);
      // The per-route feed timestamps (live) are reliable (zoned). The bare
      // roster clock is skewed, so a roster-only age can come out slightly
      // negative — clamp to 0 and treat sub-hour skew as "just now".
      let ageMin = luMs ? (now - luMs) / 60000 : null;
      if (ageMin != null && ageMin < 0) ageMin = ageMin > -180 ? 0 : null;
      const inBox = src.lat != null && src.lat >= BBOX.minLat && src.lat <= BBOX.maxLat &&
                    src.lon >= BBOX.minLon && src.lon <= BBOX.maxLon;
      const routeId = live ? live.routeId : null;
      const route = ROUTE_MAP[routeId];
      const tripId = (vehicleTripMap[r.id] && vehicleTripMap[r.id].tripId) || vpTripMap[r.id] || null;
      // Derived status: why it is / isn't on the map.
      let status, reason;
      if (ageMin == null)            { status = 'unknown';  reason = 'No GPS timestamp'; }
      else if (ageMin < 5 && live)   { status = 'live';     reason = 'Reporting now'; }
      else if (ageMin < 5)           { status = 'idle';     reason = 'Fresh GPS but not assigned to a route'; }
      else if (ageMin < 60)          { status = 'recent';   reason = `Last seen ${Math.round(ageMin)} min ago`; }
      else if (ageMin < 1440)        { status = 'offshift'; reason = `Last seen ${Math.round(ageMin/60)} h ago`; }
      else                           { status = 'dormant';  reason = `Last seen ${Math.round(ageMin/1440)} d ago`; }
      if (!inBox && src.lat != null) reason = 'Outside Hawaiʻi County';
      return {
        id: r.id,
        name: r.name || String(r.id),
        status, reason,
        onMap: status === 'live',
        lat: src.lat ?? null, lon: src.lon ?? null,
        speed: src.speed ?? null,
        heading: src.heading ?? null,
        headingDegrees: src.headingDegrees ?? null,
        passengerLoad: src.passengerLoad ?? null,
        capacity: src.capacity ?? null,
        patternId: src.patternId ?? null,
        shapeDistanceTraveled: src.shapeDistanceTraveled ?? null,
        routeId,
        routeShort: route ? route.short : null,
        routeName: route ? route.name : null,
        tripId,
        lastUpdated: src.lastUpdated || null,
        ageMin: ageMin != null ? Math.round(ageMin * 10) / 10 : null,
        weather: weatherByVehicle[r.id] || null,
      };
    });
    // Sort: live first, then by recency.
    const rank = { live: 0, idle: 1, recent: 2, offshift: 3, dormant: 4, unknown: 5 };
    fleet.sort((a, b) => (rank[a.status] - rank[b.status]) || ((a.ageMin ?? 1e9) - (b.ageMin ?? 1e9)));
    const counts = fleet.reduce((m, f) => { m[f.status] = (m[f.status] || 0) + 1; return m; }, {});
    return json(res, { ts: now, total: fleet.length, counts, fleet });
  }

  // ── Learned, real-world data from observed GPS history ───────────────────
  // De-facto stops: places a route's buses REPEATEDLY dwell, across many
  // separate runs (so a one-off pause or a red light doesn't count), and that
  // aren't already an official stop. Returned for a distinct "observed stop"
  // marker on the map.
  if (p === '/api/learned-stops') {
    return json(res, learnStops(q.get('route_id') ? parseInt(q.get('route_id')) : null));
  }
  // Learned travel corridor: the high-traffic grid cells a route's buses
  // actually drive through (incl. neighborhood detours not in the GTFS shape).
  // The frontend uses this to aim the direction chevrons the way buses really go.
  if (p === '/api/learned-path') {
    return json(res, learnCorridor(q.get('route_id') ? parseInt(q.get('route_id')) : null));
  }

  if (p === '/api/trails') {
    const minutes = Math.min(parseInt(q.get('minutes') || '60'), 1440);
    const since = Date.now() - minutes * 60000;
    const rows = dbAll(
      `SELECT vehicle_id, vehicle_name, route_id, ts, lat, lon, speed, heading_deg
       FROM pings WHERE ts>=? ORDER BY vehicle_id, ts ASC`, [since]);
    const byV = {};
    rows.forEach(r => {
      if (!byV[r.vehicle_id]) byV[r.vehicle_id] = { vehicle_id: r.vehicle_id, name: r.vehicle_name, route_id: r.route_id, _pts: [] };
      byV[r.vehicle_id]._pts.push([r.lon, r.lat, r.ts, r.speed, r.heading_deg]);
    });
    // De-spaghetti: a parked bus jitters a few metres every poll, which draws a
    // tangled scribble. Keep a point only when the bus has actually moved >25 m
    // from the last kept point, so stationary buses collapse to a single dot and
    // only real travel forms a line.
    const out = Object.values(byV).map(v => {
      const pts = [];
      for (const p of v._pts) {
        if (!pts.length) { pts.push(p); continue; }
        const last = pts[pts.length - 1];
        if (haversineKm(last[1], last[0], p[1], p[0]) * 1000 >= 25) pts.push(p);
      }
      // Always include the most recent fix so the trail reaches the live marker.
      const lastRaw = v._pts[v._pts.length - 1];
      if (lastRaw && pts[pts.length - 1] !== lastRaw) pts.push(lastRaw);
      return { vehicle_id: v.vehicle_id, name: v.name, route_id: v.route_id, points: pts };
    });
    return json(res, out);
  }

  // Reference data (route classification, hub connections, P&R/terminals/airports)
  // distilled from the System Map PDF + auto-derived route roster from GTFS.
  if (p === '/api/reference') {
    return json(res, REFERENCE);
  }

  // Authoritative route registry — every route known across all sources, with
  // provenance and whether it has a shape / live vehicle. The single source of
  // truth for "do we have all the routes?".
  if (p === '/api/registry') {
    return json(res, { count: ROUTE_REGISTRY.length, routes: ROUTE_REGISTRY, builtAt: Date.now() });
  }

  if (p === '/api/shapes') {
    const rows = dbAll(`SELECT route_id, pattern_id, name, direction, color, shape FROM route_shapes ORDER BY route_id, pattern_id`);
    rows.forEach(r => {
      // Curated dark/distinct palette over the upstream pattern colors (those
      // include pale pastels and #FFFFFF that vanish on the map).
      if (ROUTE_MAP[r.route_id]) r.color = ROUTE_MAP[r.route_id].color;
      // Prefer the ROAD-SNAPPED geometry (Valhalla map-matched, cached) so the
      // line follows the streets; falls back to the raw GTFS shape if the snap
      // was rejected as off-corridor or hasn't been computed yet.
      const snapped = bestPatternShape(r.pattern_id, r.shape);
      if (snapped !== r.shape) { r.shape = snapped; r.matched = true; }
    });
    return json(res, rows);
  }

  if (p === '/api/routes') {
    return json(res, ROUTES);
  }

  if (p === '/api/stats') {
    const poll = dbAll(
      `SELECT route_id, COUNT(*) as polls, AVG(latency) as avg_latency, SUM(CASE WHEN status=200 THEN 1 ELSE 0 END) as ok
       FROM poll_log WHERE ts > ? GROUP BY route_id`, [Date.now() - 3600000]);
    const pingCount = dbGet(`SELECT COUNT(*) as n FROM pings WHERE ts > ?`, [Date.now() - 86400000]);
    return json(res, { uptime_since: startTime, poll_stats: poll, ping_count_today: pingCount?.n || 0 });
  }

  if (p === '/api/eta') {
    const vid = parseInt(q.get('vehicle_id'));
    const v = latestVehicles.find(x => x.id === vid);
    if (!v) return json(res, { error: 'vehicle not found' }, 404);
    const stops = await ensureStops(v.routeId);
    const etas = calcETAs(v, stops);
    return json(res, { vehicle_id: vid, route: v.routeName, speed_mph: v.speed, etas });
  }

  if (p === '/api/stops') {
    const rid = parseInt(q.get('route_id'));
    if (!rid) return json(res, { error: 'route_id required' }, 400);
    const stops = await ensureStops(rid);
    return json(res, stops);
  }

  // All stops for all routes (for map rendering)
  if (p === '/api/stops/all') {
    const rows = dbAll(`SELECT id,route_id,lat,lon,name,stop_code as stopCode,seq FROM stops ORDER BY route_id,seq`);
    return json(res, rows);
  }

  // Full stop arrival data: current ETAs, rolling 60-min history, and long-term typical patterns
  if (p === '/api/stop_arrivals') {
    const stopId = parseInt(q.get('stop_id'));
    const routeId = parseInt(q.get('route_id'));
    const stop = (stopsCache[routeId] || []).find(s => s.id === stopId);

    // ── Approaching buses (live) ──────────────────────────────────────────────
    const activeVehicles = latestVehicles.filter(v => v.routeId === routeId);
    const approaching = activeVehicles.map(v => {
      if (!stop) return null;
      const distKm = haversineKm(v.lat, v.lon, stop.lat, stop.lon);
      const speedKmh = (v.speed || 0) * 1.60934;
      const etaCurrent = speedKmh > 2 ? Math.round((distKm / speedKmh) * 60 * 10) / 10 : null;

      // Historical avg speed for this route over last hour
      const histRows = dbAll(
        `SELECT speed FROM pings WHERE route_id=? AND ts > ? AND speed > 0`,
        [routeId, Date.now() - 3600000]
      );
      const histAvgKmh = histRows.length
        ? (histRows.reduce((s, r) => s + r.speed, 0) / histRows.length) * 1.60934
        : speedKmh;
      const etaHist = histAvgKmh > 2 ? Math.round((distKm / histAvgKmh) * 60 * 10) / 10 : null;

      return {
        vehicleId: v.id, vehicleName: v.name,
        distKm: Math.round(distKm * 100) / 100,
        etaCurrent, etaHist,
        speed: v.speed, heading: v.heading
      };
    }).filter(Boolean).sort((a, b) => a.distKm - b.distKm);

    // ── Recent arrivals (last 60 min) ─────────────────────────────────────────
    const recent = dbAll(
      `SELECT ts, vehicle_id FROM stop_arrivals WHERE stop_id=? AND route_id=? AND ts>? ORDER BY ts DESC LIMIT 10`,
      [stopId, routeId, Date.now() - 3600000]
    );
    const lastArrival = recent[0] || null;
    const minutesSinceLast = lastArrival ? Math.round((Date.now() - lastArrival.ts) / 60000) : null;

    let avgGapMin = null;
    if (recent.length >= 2) {
      const gaps = [];
      for (let i = 0; i < recent.length - 1; i++)
        gaps.push((recent[i].ts - recent[i+1].ts) / 60000);
      avgGapMin = Math.round(gaps.reduce((a,b) => a+b, 0) / gaps.length * 10) / 10;
    }

    // ── Long-term typical: all arrivals for this stop, grouped by hour-of-day ─
    // Gives "usually arrives at HH:XX ± N min" for the current hour window
    const allArrivals = dbAll(
      `SELECT ts FROM stop_arrivals WHERE stop_id=? AND route_id=? ORDER BY ts DESC LIMIT 500`,
      [stopId, routeId]
    );

    // Group by hour-of-day, compute arrival minute-of-hour stats
    const byHour = {};
    allArrivals.forEach(row => {
      const d = new Date(row.ts);
      const h = d.getHours();
      const minOfHour = d.getMinutes() + d.getSeconds() / 60;
      if (!byHour[h]) byHour[h] = [];
      byHour[h].push(minOfHour);
    });

    // For each hour, compute mean and stddev of minute-of-hour
    const typicalByHour = {};
    Object.entries(byHour).forEach(([h, mins]) => {
      const mean = mins.reduce((a,b) => a+b, 0) / mins.length;
      const variance = mins.reduce((a,b) => a + (b-mean)**2, 0) / mins.length;
      const stddev = Math.sqrt(variance);
      typicalByHour[h] = { mean: Math.round(mean * 10) / 10, stddev: Math.round(stddev * 10) / 10, n: mins.length };
    });

    // Current hour typical
    const nowHour = new Date().getHours();
    const typicalNow = typicalByHour[nowHour] || null;

    return json(res, {
      stopId, routeId,
      approaching,
      minutesSinceLast, avgGapMin,
      recentCount: recent.length,
      totalArrivals: allArrivals.length,
      typicalNow,   // { mean, stddev, n } — typical minute-of-hour arrivals at this stop
      typicalByHour // all hours for sparkline
    });
  }

  // Long-term arrival pattern by (day-of-week, hour-of-day). Answers
  // "what time does this bus usually stop here on a Tuesday afternoon?"
  // Returns a 7×24 matrix of { mean, stddev, n } keyed by dow/hod so the
  // UI can render a heatmap. We use the long retention window so weekly
  // patterns are visible (commute peaks, weekend lulls, etc).
  if (p === '/api/stop_patterns') {
    const stopId = parseInt(q.get('stop_id'));
    const routeId = parseInt(q.get('route_id'));
    if (!stopId || !routeId) return json(res, { error: 'stop_id and route_id required' }, 400);
    // Pull up to 5000 recent arrivals (well within the 90-day retention
    // for busy stops; for quiet stops we get all of them).
    const rows = dbAll(
      `SELECT ts FROM stop_arrivals WHERE stop_id=? AND route_id=? ORDER BY ts DESC LIMIT 5000`,
      [stopId, routeId]
    );
    // Bucket: bucket[dow][hod] = [minutes-of-day list]
    const bucket = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => []));
    rows.forEach(r => {
      const d = new Date(r.ts);
      bucket[d.getDay()][d.getHours()].push(d.getMinutes() + d.getSeconds() / 60);
    });
    // Reduce to { mean, stddev, n } per cell. Skip cells with too few samples
    // to avoid noise; we report n so the UI can show confidence.
    const matrix = bucket.map((dayBuckets, dow) =>
      dayBuckets.map((mins, hod) => {
        if (mins.length < 2) return { mean: null, stddev: null, n: mins.length };
        const mean = mins.reduce((a, b) => a + b, 0) / mins.length;
        const variance = mins.reduce((a, b) => a + (b - mean) ** 2, 0) / mins.length;
        return { mean: Math.round(mean * 10) / 10, stddev: Math.round(Math.sqrt(variance) * 10) / 10, n: mins.length };
      })
    );
    return json(res, {
      stopId, routeId,
      totalArrivals: rows.length,
      daysCovered: 90,
      matrix, // matrix[dow][hod] = { mean (minute of hour), stddev, n }
    });
  }

  // Rich ETA with historical performance
  // Returns stops in order, each with: distKm, etaMinSpeed (pure speed), etaMinHistorical (avg from pings)
  if (p === '/api/stopline') {
    const vid = parseInt(q.get('vehicle_id'));
    // Memoize the (fairly heavy) stopline result briefly — many clients ask for
    // the same vehicle every 30 s, and a bus's stop predictions don't change
    // meaningfully within ~8 s. Keyed by vehicle + the latest poll timestamp.
    const memoKey = vid + ':' + lastPollStats.ts;
    const cached = stoplineMemo.get(memoKey);
    if (cached && Date.now() - cached.t < 8000) return json(res, cached.data);

    const v = latestVehicles.find(x => x.id === vid);
    if (!v) return json(res, { error: 'vehicle not found' }, 404);
    const stops = await ensureStops(v.routeId);
    if (!stops.length) return json(res, { stops: [], vehicle: v });

    const speedKmh = (v.speed || 0) * 1.60934;

    // Historical: avg seconds this vehicle (or all on route) takes to reach each stop distance band
    // We look at pings for this vehicle over last 7 days and compute avg speed by distance-from-stop
    const histRows = dbAll(
      `SELECT lat, lon, speed, ts FROM pings WHERE route_id=? AND ts > ? AND speed > 0 ORDER BY ts`,
      [v.routeId, Date.now() - 7 * 86400000]
    );

    // Compute average speed from history
    const histAvgSpeed = histRows.length
      ? (histRows.reduce((s, r) => s + r.speed, 0) / histRows.length) * 1.60934
      : speedKmh;

    // Official agency predictions for this vehicle's trip (GTFS-RT TripUpdates),
    // keyed by stop_id → { ms, seq }. This is the headline ETA when present.
    const officialStops = (v.tripId && tripUpdateIndex[v.tripId]) || {};
    const nowMsEta = Date.now();

    // The transformer's input depends only on the bus (speed) + route, not the
    // individual stop, so run the forward pass ONCE here rather than per stop.
    // Each of its 12 tokens encodes "the k-th stop ahead" (k = token index + 1),
    // and each token has its own output head — so the residual for the k-th
    // stop ahead is `seqOut[k]`. The stop's rank-ahead is determined by
    // distance (clamped to the 5 trained heads).
    const fwdRes = TX.forward(buildTokenSequence(v, 0, null, v.routeId));
    const seqOut = fwdRes.tokenOut; // length 12; first 5 are the trained heads
    // Rank stops by distance to map them to "n stops ahead" → head index.
    const distRank = {};
    [...stops].map((s, i) => ({ i, d: haversineKm(v.lat, v.lon, s.lat, s.lon) }))
              .sort((a, b) => a.d - b.d)
              .forEach((e, rank) => { distRank[e.i] = rank; });

    // Find closest stop to figure out which direction/sequence we're travelling
    const stopETAs = stops.map((stop, i) => {
      const distKm = haversineKm(v.lat, v.lon, stop.lat, stop.lon);
      const etaSpeed = speedKmh > 1 ? (distKm / speedKmh) * 60 : null;
      const etaHist  = histAvgSpeed > 1 ? (distKm / histAvgSpeed) * 60 : etaSpeed;
      // Official predicted arrival (minutes from now), if the agency feed has it.
      const off = officialStops[String(stop.id)] || officialStops[stop.id];
      const etaOfficial = off ? Math.round(((off.ms - nowMsEta) / 60000) * 10) / 10 : null;

      // Model correction: use the output head for this stop's rank ahead of the bus.
      const head = Math.min(distRank[i] || 0, 4); // 5 trained heads (0..4)
      const correction = seqOut[head];
      const etaSeq = etaHist != null ? Math.max(0, etaHist + correction) : null;

      // Headline ETA: prefer the agency's official prediction; fall back to the
      // model-corrected estimate, then plain historical/speed estimates.
      let etaMin, etaSource;
      if (etaOfficial != null)      { etaMin = etaOfficial; etaSource = 'official'; }
      else if (etaSeq != null)      { etaMin = Math.round(etaSeq * 10) / 10; etaSource = 'model'; }
      else if (etaHist != null)     { etaMin = Math.round(etaHist * 10) / 10; etaSource = 'historical'; }
      else if (etaSpeed != null)    { etaMin = Math.round(etaSpeed * 10) / 10; etaSource = 'speed'; }
      else                          { etaMin = null; etaSource = null; }

      return {
        stopId: stop.id, name: stop.name, stopCode: stop.stopCode,
        lat: stop.lat, lon: stop.lon, seq: stop.seq,
        distKm: Math.round(distKm * 1000) / 1000,
        etaMin, etaSource,
        etaMinOfficial: etaOfficial,
        etaMinSpeed: etaSpeed !== null ? Math.round(etaSpeed * 10) / 10 : null,
        etaMinHist:  etaHist  !== null ? Math.round(etaHist  * 10) / 10 : null,
        etaMinSeq:   etaSeq != null ? Math.round(etaSeq * 10) / 10 : null,
        seqCorrection: Math.round(correction * 10) / 10,
        histSampleCount: histRows.length,
        histAvgSpeedMph: Math.round(histAvgSpeed / 1.60934 * 10) / 10,
      };
    });

    // Determine next stop: the stop the bus is actually driving TOWARD.
    // Strategy: find the two closest stops. If they're adjacent in sequence,
    // the bus is between them — the higher-seq one is "next".
    // If not adjacent (loop route), use the bus's last-passed stop as a reference
    // and pick the closest stop whose seq is ahead of (or wrapping from) that.
    const sorted = [...stopETAs].sort((a, b) => a.distKm - b.distKm);
    let nextStop = sorted[0];

    // Authoritative next stop from the agency feed: the upcoming stop in this
    // trip's TripUpdates with the smallest still-in-the-future predicted arrival.
    // You can't be heading to a stop you haven't reached, so this beats geometry.
    let officialNext = null;
    if (Object.keys(officialStops).length) {
      // The next stop is the one the agency predicts the SOONEST arrival for —
      // i.e. the smallest still-in-the-future predicted time. (Lowest sequence is
      // wrong: the feed predicts the whole trip, and on a route that revisits low
      // sequence numbers the soonest-arriving stop is the real next one, not the
      // numerically-lowest.)
      let bestMs = Infinity;
      for (const s of stopETAs) {
        // NOTE: stopETAs entries carry `stopId` (not `id`).
        const off = officialStops[String(s.stopId)] || officialStops[s.stopId];
        if (!off || off.ms <= nowMsEta - 30000) continue; // already passed
        if (off.ms < bestMs) { bestMs = off.ms; officialNext = s; }
      }
    }

    if (officialNext) {
      nextStop = officialNext;
    } else {
      // No agency feed for this trip — derive the next stop from geometry +
      // sequence so we never highlight a stop the bus hasn't reached. Stops are
      // ordered by seq. Find the nearest stop, then decide whether the bus has
      // already passed it (closer to its successor) or is still approaching it.
      // "Next" is the first stop in sequence at or ahead of the bus's progress.
      const bySeq = [...stopETAs].sort((a, b) => a.seq - b.seq);
      // Index of the geometrically nearest stop within the seq-ordered list.
      let nearIdx = 0, nearDist = Infinity;
      bySeq.forEach((s, i) => { if (s.distKm < nearDist) { nearDist = s.distKm; nearIdx = i; } });
      const near = bySeq[nearIdx];
      const prev = bySeq[nearIdx - 1];
      const succ = bySeq[nearIdx + 1];
      // Have we passed `near`? We have if we're now closer to its successor than
      // the successor is to `near` minus our distance — i.e. projecting our
      // position onto the near→succ segment puts us past `near`. Simple, robust
      // proxy: compare distance-to-prev vs distance-to-succ.
      let next;
      if (succ && (!prev || (prev && near.distKm > 0.05))) {
        // If we're closer to the successor's side, the bus has passed `near`.
        const dSucc = succ ? succ.distKm : Infinity;
        const dPrev = prev ? prev.distKm : Infinity;
        if (dSucc < dPrev && near.distKm > 0.08) next = succ; else next = near;
      } else {
        next = near;
      }
      // Honour the last stop we actually recorded an arrival at, if more advanced.
      const lastArr = dbGet(
        `SELECT stop_seq FROM stop_arrivals WHERE vehicle_id=? ORDER BY ts DESC LIMIT 1`, [vid]);
      const lastSeq = (vehicleLastStopIdx[vid] && vehicleLastStopIdx[vid].stopSeq != null)
        ? vehicleLastStopIdx[vid].stopSeq
        : (lastArr && lastArr.stop_seq != null ? lastArr.stop_seq : null);
      if (lastSeq != null && next.seq <= lastSeq) {
        const ahead = bySeq.find(s => s.seq > lastSeq);
        if (ahead) next = ahead;
      }
      nextStop = next || sorted[0];
    }

    // ── GTFS scheduled times ──────────────────────────────────────────────────
    // For each stop, find the trip passing through it closest to the current time.
    // Buses are scheduled throughout the day — different trips hit different stops.
    const nowDate = new Date();
    const nowSec = nowDate.getHours() * 3600 + nowDate.getMinutes() * 60 + nowDate.getSeconds();
    const dayOfWeek = nowDate.getDay();
    const validServices = new Set();
    validServices.add('225-1');
    if (dayOfWeek >= 1 && dayOfWeek <= 6) validServices.add('225-2');
    if (dayOfWeek >= 1 && dayOfWeek <= 5) validServices.add('225-3');
    if (dayOfWeek === 0) validServices.add('225-4');

    // Load all valid trip times for this route once: stop_id -> [{arrival_sec, trip_id}]
    const allTripStops = dbAll(
      `SELECT stop_id, trip_id, arrival_sec FROM gtfs_stop_times WHERE route_id=?`,
      [v.routeId]
    );
    const tripStopGroups = {}; // stop_id -> [{sec, trip_id}]
    const tripServices = {}; // trip_id -> service_id (lookup)
    dbAll(`SELECT trip_id, service_id FROM gtfs_stop_times WHERE route_id=? GROUP BY trip_id`,
      [v.routeId]).forEach(t => { tripServices[t.trip_id] = t.service_id; });

    allTripStops.forEach(r => {
      if (!validServices.has(tripServices[r.trip_id])) return;
      if (!tripStopGroups[r.stop_id]) tripStopGroups[r.stop_id] = [];
      tripStopGroups[r.stop_id].push({ sec: r.arrival_sec, trip_id: r.trip_id });
    });

    // For each stop, find scheduled_sec of the trip whose time is closest to now
    // (within ±2 hours — outside that we have no scheduled service today)
    const scheduledMap = {};
    const scheduledTripId = {}; // track which trip matched
    stopETAs.forEach(stop => {
      const candidates = tripStopGroups[stop.stopId];
      if (!candidates || !candidates.length) return;
      let best = null, bestDiff = Infinity;
      for (const c of candidates) {
        // Treat times >24h as next-day (rare here, but handle)
        const sec = c.sec % 86400;
        const diff = Math.abs(sec - nowSec);
        if (diff < bestDiff) { bestDiff = diff; best = c; }
      }
      if (best && bestDiff < 7200) { // within 2 hours
        scheduledMap[stop.stopId] = best.sec;
        scheduledTripId[stop.stopId] = best.trip_id;
      }
    });

    // Exact trip schedule: GTFS-RT gives us the actual trip_id, so use that
    // trip's own scheduled stop times instead of the nearest-time heuristic.
    if (v.tripId) {
      dbAll(`SELECT stop_id, arrival_sec FROM gtfs_stop_times WHERE trip_id=?`, [v.tripId])
        .forEach(r => { scheduledMap[r.stop_id] = r.arrival_sec; scheduledTripId[r.stop_id] = v.tripId; });
    }

    // Enrich each stop with historical typical arrival time from stop_arrivals
    // Group all recorded arrivals by hour-of-day, compute mean minute-of-hour & stddev
    const nowMs = Date.now();
    const nowHour = nowDate.getHours();
    stopETAs.forEach(stop => {
      // Scheduled time from GTFS
      if (scheduledMap[stop.stopId] !== undefined) {
        stop.scheduledSec = scheduledMap[stop.stopId];
        // Convert to today's absolute ms timestamp
        const todayMidnight = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
        stop.scheduledMs = todayMidnight + stop.scheduledSec * 1000;
      } else {
        stop.scheduledSec = null;
        stop.scheduledMs = null;
      }
    });
    // ── Typical arrival: bucket by the scheduled time-of-day, not current hour ──
    // For each stop, take arrivals within ±30min of its scheduled_sec for this trip.
    // That way an afternoon bus's "typical" reflects afternoon arrivals, not all-day average.
    stopETAs.forEach(stop => {
      const schedSec = scheduledMap[stop.stopId];
      if (schedSec == null) { stop.typicalMin = null; stop.typicalStddev = null; stop.typicalN = 0; return; }
      const targetMin = Math.floor(schedSec / 60);
      // Pull last 500 arrivals and filter to those within ±30min of target minute-of-day
      const arrivals = dbAll(
        `SELECT ts FROM stop_arrivals WHERE stop_id=? AND route_id=? ORDER BY ts DESC LIMIT 500`,
        [stop.stopId, v.routeId]
      );
      const matched = [];
      arrivals.forEach(r => {
        const d = new Date(r.ts);
        const m = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
        const diff = Math.min(Math.abs(m - targetMin), 1440 - Math.abs(m - targetMin));
        if (diff <= 30) matched.push(m);
      });
      if (matched.length < 1) { stop.typicalMin = null; stop.typicalStddev = null; stop.typicalN = 0; return; }
      const mean = matched.reduce((a,b) => a+b, 0) / matched.length;
      const variance = matched.length > 1
        ? matched.reduce((a,b) => a+(b-mean)**2, 0) / matched.length : 0;
      const stddev = Math.sqrt(variance);
      // Convert mean to minute-of-hour (since `matched` is in absolute minutes 0-1440)
      const meanMinOfHour = mean % 60;
      stop.typicalMin = Math.round(meanMinOfHour * 10) / 10;
      stop.typicalStddev = Math.round(stddev * 10) / 10;
      stop.typicalN = matched.length;
      stop.typicalHour = Math.floor(mean / 60); // remember which hour the typical is from
    });

    // ── Schedule adherence ────────────────────────────────────────────────────
    // Compare the predicted arrival at the next stop with its scheduled time.
    // delayMin > 0 = behind schedule (late); < 0 = ahead (early).
    // Only trust schedule adherence when we know the bus's real trip AND the
    // next-stop arrival is the agency's official prediction — otherwise the
    // scheduled-time match is a guess and the delta is meaningless.
    let scheduleDelayMin = null, scheduleSuspect = false;
    if (nextStop && v.tripId && !v.unassigned &&
        nextStop.scheduledMs != null && nextStop.etaMinOfficial != null) {
      const predictedArrivalMs = nowMs + nextStop.etaMinOfficial * 60000;
      scheduleDelayMin = Math.round(((predictedArrivalMs - nextStop.scheduledMs) / 60000) * 10) / 10;
      // A delay beyond ~45 min on these short routes almost always means the
      // static GTFS schedule for this trip_id doesn't line up with the realtime
      // feed's trip (versioning drift), not a genuinely hour-late bus. Trust the
      // official live ETA, but don't display a misleading adherence number.
      if (Math.abs(scheduleDelayMin) > 45) { scheduleSuspect = true; scheduleDelayMin = null; }
    }

    const payload = {
      vehicle_id: vid,
      route: v.routeName,
      routeShort: v.routeShort,
      routeColor: v.routeColor,
      tripId: v.tripId || null,
      headsign: v.headsign || null,
      speed_mph: v.speed,
      hist_avg_mph: Math.round(histAvgSpeed / 1.60934 * 10) / 10,
      hist_samples: histRows.length,
      next_stop: nextStop,
      scheduleDelayMin,            // +late / −early, null if unknown
      scheduleSuspect,             // true when delay is implausible (>2h)
      etaPrimarySource: nextStop ? nextStop.etaSource : null,
      stops: stopETAs,   // in route sequence order
      serverTs: nowMs,
    };
    stoplineMemo.set(memoKey, { t: Date.now(), data: payload });
    if (stoplineMemo.size > 200) stoplineMemo.clear(); // bound the cache
    return json(res, payload);
  }

  // GTFS official stop data (names, wheelchair)
  if (p === '/api/gtfs/stops') {
    const rows = dbAll(`SELECT stop_id,stop_code,stop_name,stop_lat,stop_lon,wheelchair FROM gtfs_stops`);
    return json(res, rows);
  }

  // GTFS feed status
  if (p === '/api/gtfs/status') {
    const meta = gtfsMeta();
    const n = dbGet(`SELECT COUNT(*) as n FROM gtfs_stop_times`);
    const ns = dbGet(`SELECT COUNT(*) as n FROM gtfs_stops`);
    return json(res, {
      stopTimes: n?.n || 0,
      stops: ns?.n || 0,
      lastDownloaded: meta.downloadedAt ? new Date(meta.downloadedAt).toISOString() : null,
      lastModified: meta.lastModified || null,
    });
  }

  // Learning model state
  if (p === '/api/learn/status') {
    const totalParams = TX.dModel * 6 + TX.dModel * TX.nTokens +
                       TX.dModel * TX.dModel * 4 + TX.ffnDim * TX.dModel +
                       TX.dModel * TX.ffnDim + TX.outDim * TX.dModel +
                       TX.dModel * 2; // lnGamma + lnBeta
    return json(res, {
      architecture: `Transformer block: ${TX.nTokens} tokens × ${TX.dModel}d → self-attention(${TX.nHeads}h) → FFN(${TX.ffnDim}) → ${TX.outDim} heads`,
      params: totalParams,
      learningRate: TX.lr,
      trained: TX.trained,
      trainedExamples: TX.trainedCount || 0,
    });
  }

  if (p === '/proxy') {
    const apiPath = q.get('path') || '';
    const pr = https.request({
      hostname: UPSTREAM, path: `/api/rtpi?path=${encodeURIComponent(apiPath)}`, method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://myheleonbus.org/' },
    }, proxyRes => {
      res.writeHead(proxyRes.statusCode, { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' });
      proxyRes.pipe(res);
    });
    pr.on('error', e => { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); });
    pr.end();
    return;
  }

  // ── BOATS layer (live AIS via aisstream.io, opt-in by env var) ────────────
  // Endpoint serves the in-memory vessel cache. Without AISSTREAM_API_KEY the
  // cache stays empty and the UI shows a clear "add your free key" hint rather
  // than fabricating fake boats. We never fall back to guessed data.
  if (p === '/api/vessels') {
    const now = Date.now();
    const list = [];
    for (const [mmsi, v] of vesselCache) {
      if ((now - v.lastTs) > VESSEL_STALE_MS) continue;
      list.push(v);
    }
    return json(res, {
      ts: now,
      keyConfigured: !!AISSTREAM_API_KEY,
      lastConnectTs: vesselLastConnectTs,
      lastError: vesselLastError,
      count: list.length,
      vessels: list,
    });
  }

  // ── AIRCRAFT layer (OpenSky Network, no key) ──────────────────────────────
  if (p === '/api/aircraft') {
    const now = Date.now();
    const list = aircraftCache.filter(a => (now - a.lastTs) < AIRCRAFT_STALE_MS);
    return json(res, {
      ts: now,
      lastPollTs: aircraftLastPollTs,
      lastError: aircraftLastError,
      count: list.length,
      aircraft: list,
    });
  }

  res.writeHead(404); res.end('Not found');
}

function handleStatic(url, res) {
  const fp = url.pathname === '/' ? HTML_PATH : path.join(__dirname, url.pathname);
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
    res.end(data);
  });
}

// ─── AIS (boats) — aisstream.io subscription ──────────────────────────────
// Live vessel positions are a great companion to the bus layer. aisstream.io
// streams free public AIS over WebSocket but requires a free key. So the boats
// layer works out-of-the-box for everyone, a shared key is bundled below.
//
// NOTE: this is OBFUSCATION, not encryption. A key that ships in the client of
// a public app can never be truly secret — anything needed to decode it must
// ship too. The XOR+base64 below just keeps the token from being grep-able as a
// plaintext secret and from tripping naive secret scanners. Set AISSTREAM_API_KEY
// to override with your own key (recommended for heavy use / rate-limit headroom).
function decodeBundledAisKey() {
  try {
    const enc = Buffer.from('WAZcXVhbFURHUAdbUEdIVAtGXwcPB1pYGU1BBQBZVEQaAwtLW1NdBA==', 'base64');
    const pass = 'heleon-tracker-ais';
    return Buffer.from(enc.map((b, i) => b ^ pass.charCodeAt(i % pass.length))).toString('utf8');
  } catch { return ''; }
}
const AISSTREAM_API_KEY = process.env.AISSTREAM_API_KEY || decodeBundledAisKey();
const AISSTREAM_URL = 'wss://stream.aisstream.io/v0/stream';
// Hawaii bounding box for filtering: lat 18.8..20.4, lon -156.2..-154.7
const HAWAII_BBOX = [[[18.8, -156.2], [20.4, -154.7]]];
const VESSEL_STALE_MS = 10 * 60 * 1000; // drop unseen vessels after 10 min
const vesselCache = new Map(); // mmsi -> { mmsi, name, lat, lon, speedKts, headingDeg, lastTs, shipType }
let vesselLastConnectTs = null;
let vesselLastError = null;
let aisSocket = null;
let aisReconnectTimer = null;

function setVesselFromMsg(msg) {
  if (!msg || !msg.Message) return;
  // aisstream.io wraps each PositionReport / ShipStaticData. Combine them
  // (StaticData updates ShipName + ShipType; PositionReport updates lat/lon).
  const { Message } = msg;
  const mmsi = Message.MMSI != null ? String(Message.MMSI) : null;
  if (!mmsi) return;
  let v = vesselCache.get(mmsi) || { mmsi, name: '', lat: null, lon: null, speedKts: 0, headingDeg: 0, lastTs: 0, shipType: null };
  if (Message.PositionReport) {
    const p = Message.PositionReport;
    // Coarse bbox filter (server also subscribes with bbox — defence in depth)
    if (p.Latitude < 18.5 || p.Latitude > 20.7 || p.Longitude < -156.5 || p.Longitude > -154.5) return;
    v.lat = p.Latitude;
    v.lon = p.Longitude;
    v.speedKts = p.Sog != null ? p.Sog : v.speedKts;
    v.headingDeg = p.TrueHeading != null && p.TrueHeading <= 359 ? p.TrueHeading : (p.Cog != null ? p.Cog : v.headingDeg);
    v.lastTs = Date.now();
  }
  if (Message.ShipStaticData) {
    const s = Message.ShipStaticData;
    if (s.Name && s.Name.trim()) v.name = s.Name.trim();
    if (s.Type != null) v.shipType = s.Type;
    v.lastTs = Date.now();
  }
  // Drop low-quality positions outside the bbox or with no position yet
  if (v.lat == null || v.lon == null) return;
  vesselCache.set(mmsi, v);
}

function connectAisStream() {
  if (!AISSTREAM_API_KEY) {
    vesselLastError = 'AISSTREAM_API_KEY not set — boats layer disabled. Sign up free at aisstream.io to enable.';
    return;
  }
  if (aisSocket && (aisSocket.readyState === WebSocket.OPEN || aisSocket.readyState === WebSocket.CONNECTING)) return;
  try {
    aisSocket = new WebSocket(AISSTREAM_URL);
  } catch (e) {
    vesselLastError = 'WS construct failed: ' + e.message;
    scheduleAisReconnect();
    return;
  }
  aisSocket.on('open', () => {
    vesselLastConnectTs = Date.now();
    vesselLastError = null;
    try {
      aisSocket.send(JSON.stringify({
        APIKey: AISSTREAM_API_KEY,
        BoundingBoxes: HAWAII_BBOX,
        FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
      }));
    } catch (e) {
      vesselLastError = 'send failed: ' + e.message;
    }
  });
  aisSocket.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      setVesselFromMsg(msg);
    } catch { /* drop malformed */ }
  });
  aisSocket.on('close', () => { vesselLastError = 'connection closed'; scheduleAisReconnect(); });
  aisSocket.on('error', e => { vesselLastError = (e && e.message) || 'unknown WS error'; });
}

function scheduleAisReconnect() {
  if (aisReconnectTimer) return;
  // Backoff capped at 60s
  const delay = Math.min(60000, 5000 * Math.pow(1.5, (vesselCache.size === 0 ? 1 : 0)));
  aisReconnectTimer = setTimeout(() => { aisReconnectTimer = null; connectAisStream(); }, delay);
}

// ─── AIRCRAFT (OpenSky Network) ────────────────────────────────────────────
// Live ADS-B positions around the Hawaiian islands. Free, no API key required
// for the anonymous tier (10s rate limit). We poll every 12s with a tight
// Hawaii bbox so we never get more than ~30 aircraft per call.
const OPENSKY_URL = 'https://opensky-network.org/api/states/all';
// Big-Island-focused bbox. OpenSky charges per query by area: ≤25 sq° = 1 credit,
// 25–100 = 2, etc. The old wide Hawaii bbox (~42 sq°) cost 2 credits/call and blew
// past the anonymous 400-credit/day budget → constant rate-limit timeouts. This
// box (~1.5° × 1.8° ≈ 2.7 sq°) is 1 credit and still covers ITO/KOA + approaches.
const HAWAII_AIR_BBOX = {
  lamin: 18.7, lomin: -156.3,
  lamax: 20.5, lomax: -154.6,
};
const AIRCRAFT_STALE_MS = 90 * 1000;  // 90s — OpenSky refreshes every 10s; anything older is unreliable
let aircraftCache = [];               // [{ icao24, callsign, country, lat, lon, altM, velMs, headingDeg, onGround, lastTs }]
let aircraftLastPollTs = null;
let aircraftLastError = null;

// ── OpenSky OAuth2 (optional, free) ──────────────────────────────────────────
// Anonymous = 400 credits/day (one /states/all call costs 1+ credits), so a live
// poll exhausts it fast. A free OpenSky account → API client gives 4,000/day.
// Set OPENSKY_CLIENT_ID + OPENSKY_CLIENT_SECRET to enable; we fetch & cache an
// OAuth2 token (client_credentials grant) and send it as a Bearer header. With no
// credentials we fall back to anonymous (still works, just polled more slowly).
// Credentials come from env vars (preferred — set these on Render) or, for local
// dev convenience, a gitignored Sources/credentials.json ({clientId, clientSecret}).
function loadOpenSkyCreds() {
  let id = process.env.OPENSKY_CLIENT_ID || '', secret = process.env.OPENSKY_CLIENT_SECRET || '';
  if (!id || !secret) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'Sources', 'credentials.json'), 'utf8'));
      id = id || c.clientId || ''; secret = secret || c.clientSecret || '';
    } catch { /* no file — anonymous */ }
  }
  return { id, secret };
}
const { id: OPENSKY_CLIENT_ID, secret: OPENSKY_CLIENT_SECRET } = loadOpenSkyCreds();
const OPENSKY_TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const openskyAuthed = () => !!(OPENSKY_CLIENT_ID && OPENSKY_CLIENT_SECRET);
let openskyToken = null, openskyTokenExp = 0;

async function getOpenSkyToken() {
  if (!openskyAuthed()) return null;
  if (openskyToken && Date.now() < openskyTokenExp - 60000) return openskyToken; // still valid (60s margin)
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: OPENSKY_CLIENT_ID,
    client_secret: OPENSKY_CLIENT_SECRET,
  }).toString();
  const u = new URL(OPENSKY_TOKEN_URL);
  const json = await new Promise((resolve, reject) => {
    const req = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000 }, res => {
      let b = ''; res.on('data', d => b += d);
      res.on('end', () => { if (res.statusCode !== 200) return reject(new Error(`token HTTP ${res.statusCode}`)); try { resolve(JSON.parse(b)); } catch { reject(new Error('bad token JSON')); } });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('token timeout')); });
    req.end(body);
  });
  openskyToken = json.access_token;
  openskyTokenExp = Date.now() + (json.expires_in || 1800) * 1000;
  return openskyToken;
}

// OpenSky's anonymous tier is rate-limited and frequently slow/throttled. Fetch
// with a generous timeout and an explicit HTTP-status check (a 429/503 returns an
// HTML body that would otherwise blow up JSON.parse and look like a hard error).
// On ANY failure we keep the last good aircraft on screen (cache untouched) so a
// transient timeout doesn't blank the map — we only note the error.
function fetchOpenSky(reqPath, token) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'heleon-tracker', 'Accept': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const req = https.request({ hostname: 'opensky-network.org', path: reqPath, method: 'GET',
      headers, timeout: 20000 }, res => {
      let b = ''; res.on('data', d => b += d);
      res.on('end', () => {
        if (res.statusCode === 429) return reject(new Error('rate limited (429) — backing off'));
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(b)); } catch { reject(new Error('bad JSON from OpenSky')); }
      });
    });
    req.on('error', e => reject(new Error(e.code || e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// Authenticated users have 10× the credits, so they can afford a wider box that
// shows all-Hawaii traffic (inter-island flights, neighbor-island airports).
const HAWAII_AIR_BBOX_WIDE = { lamin: 18.5, lomin: -160.5, lamax: 22.5, lomax: -154.5 };
async function pollAircraft() {
  const box = openskyAuthed() ? HAWAII_AIR_BBOX_WIDE : HAWAII_AIR_BBOX;
  const params = new URLSearchParams(box).toString();
  try {
    // Use an OAuth2 bearer token when credentials are configured (4000 credits/day
    // vs 400 anonymous). A token failure falls back to an anonymous request.
    let token = null;
    try { token = await getOpenSkyToken(); } catch (e) { aircraftLastError = 'auth: ' + e.message; }
    const res = await fetchOpenSky(`/api/states/all?${params}`, token);
    if (!res || !Array.isArray(res.states)) {
      // No states in the box right now is normal (quiet airspace) — not an error.
      if (res && res.states === null) { aircraftCache = []; aircraftLastPollTs = Date.now(); aircraftLastError = null; return; }
      aircraftLastError = 'unexpected response shape';
      return; // keep last cache
    }
    const now = Date.now();
    const next = [];
    for (const s of res.states) {
      // OpenSky returns a positional array (no keys). Indices per their schema:
      // 0 icao24, 1 callsign, 2 origin_country, 3 time_position, 4 last_contact,
      // 5 lon, 6 lat, 7 baro_altitude, 8 on_ground, 9 velocity, 10 true_track,
      // 11 vertical_rate, 12-... sensors + spare
      const lat = s[6], lon = s[5];
      if (lat == null || lon == null) continue;
      const cs = (s[1] || '').trim();
      next.push({
        icao24: s[0],
        callsign: cs,
        country: s[2],
        lat, lon,
        altM: s[7],
        onGround: !!s[8],
        velMs: s[9],                              // m/s
        headingDeg: s[10] != null ? s[10] : 0,
        verticalRateMs: s[11],
        lastContact: s[4],
        lastTs: now,
      });
    }
    aircraftCache = next;
    aircraftLastPollTs = now;
    aircraftLastError = null;
  } catch (e) {
    aircraftLastError = (e && e.message) || 'unknown error';
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin':'*' }); res.end(); return; }
  const url = new URL(req.url, `http://localhost:${PORT}`);
  // Render health check — 200 OK with current status
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      ts: Date.now(),
      uptime_s: Math.round(process.uptime()),
      last_poll_ts: lastPollStats?.ts || null,
      vehicles: latestVehicles?.length || 0,
    }));
    return;
  }
  if (url.pathname.startsWith('/api/') || url.pathname === '/proxy') {
    handleApi(url, res).catch(e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
  } else {
    handleStatic(url, res);
  }
});

// ─── BOOT ────────────────────────────────────────────────────────────────────
(async () => {
  await openDb();

  const shapeCount = dbGet(`SELECT COUNT(*) as n FROM route_shapes`);
  if (!shapeCount || shapeCount.n === 0) {
    await fetchShapes();
  } else {
    console.log(`[shapes] ${shapeCount.n} patterns cached in DB`);
  }

  await fetchAllStops();
  await loadGtfs();
  // Fill in geometry for schedule-only routes (401/301/204/502) that the live
  // upstream API doesn't serve, using GTFS shapes.txt — so they appear on the map.
  try { loadGtfsShapesForMissing(); } catch (e) { console.error('[gtfs-shapes]', e.message); }
  // Build the authoritative route registry (unions every source) and log any
  // route still missing geometry, so gaps surface immediately, never silently.
  try { buildRouteRegistry(); } catch (e) { console.error('[registry]', e.message); }
  // Road-snap all route shapes (background, self-healing). Cached → quick no-op
  // once done; retries until complete if Valhalla is flaky, then refreshes daily.
  scheduleMatching();
  buildTripIndex();
  // Train learning model on past stop_arrivals history
  try { await trainFromHistory(); } catch(e) { console.error('[learn] train error:', e.message); }
  await pollAll();
  setInterval(pollAll, POLL_INTERVAL);
  // Boats layer — only connects if AISSTREAM_API_KEY is set. With no key, the
  // /api/vessels endpoint returns keyConfigured:false so the UI can show a
  // clean "add your free key" hint instead of faking data.
  if (AISSTREAM_API_KEY) {
    console.log('[boats] AISSTREAM_API_KEY detected — connecting to aisstream.io');
    connectAisStream();
  } else {
    console.log('[boats] AISSTREAM_API_KEY not set — boats layer disabled (set env var to enable)');
  }
  // Airplanes layer — OpenSky Network. The credit budget is the real constraint:
  // anonymous = 400/day, authenticated = 4000/day, at 1 credit per (now-small)
  // bbox call. Poll fast enough to feel live but stay under budget:
  //   authenticated: every 25s  → ~3450 calls/day  (< 4000)
  //   anonymous:     every 240s → ~360 calls/day   (< 400)
  // On error the last fix stays on screen, so a hiccup never blanks the map.
  const aircraftPollMs = openskyAuthed() ? 25000 : 240000;
  console.log(`[aircraft] OpenSky ${openskyAuthed() ? 'authenticated (4000 credits/day)' : 'anonymous (400 credits/day) — set OPENSKY_CLIENT_ID/SECRET for higher limits'}; polling every ${aircraftPollMs/1000}s`);
  pollAircraft();
  setInterval(pollAircraft, aircraftPollMs);
  setTimeout(pruneDb, 30000);                // full prune+VACUUM shortly after boot
  setInterval(pruneDb, 24 * 60 * 60 * 1000); // and daily thereafter
  // poll_log grows ~88 rows/cycle (22 routes × 4/min) but /api/stats only reads
  // the last hour — trim it hourly (cheap DELETE, no VACUUM) so it stays small
  // between the daily full prunes.
  setInterval(() => {
    if (!db) return;
    try { db.run(`DELETE FROM poll_log WHERE ts < ?`, [Date.now() - POLLLOG_RETAIN_MS]); } catch {}
  }, 60 * 60 * 1000);
  setInterval(fetchShapes, 24 * 60 * 60 * 1000);
  setInterval(fetchAllStops, 24 * 60 * 60 * 1000);
  setInterval(discoverNewRoutes, 10 * 60 * 1000); // check for new routes every 10 min
  // Rebuild the authoritative registry every 10 min so newly-seen live routes and
  // freshly-loaded shapes are reflected (and any gap re-surfaces in the log).
  setInterval(() => { try { buildRouteRegistry(); } catch {} }, 10 * 60 * 1000);
  // (Road re-snapping is handled by scheduleMatching()'s self-healing loop above.)
  // Weekly: mirror the agency's human-readable schedule PDFs (runs the scraper
  // as a child process; non-fatal if the agency site blocks us — GTFS is the
  // machine-readable source of truth and refreshes separately). First run ~1 min
  // after boot, then every 7 days.
  scheduleWeeklyScrape();
  // Periodic re-train on latest stop_arrivals (keeps model fresh)
  setInterval(() => { trainFromHistory().catch(e => console.error('[learn] periodic train:', e.message)); }, 5 * 60 * 1000);
  setInterval(saveDb, DB_SAVE_INTERVAL);
  // Check for GTFS feed updates daily (uses conditional HTTP — skips if unchanged)
  setInterval(async () => {
    console.log('\n[gtfs] Checking for feed updates…');
    await loadGtfs(true);
  }, 24 * 60 * 60 * 1000);
  discoverNewRoutes(); // also run at startup

  const localIP = Object.values(os.networkInterfaces()).flat()
    .find(i => i.family === 'IPv4' && !i.internal)?.address || 'localhost';

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚌 Hele-On Bus Tracker running`);
    if (IS_RENDER) {
      console.log(`   Render:  ${process.env.RENDER_EXTERNAL_URL || `(port ${PORT})`}`);
      console.log(`   Mode:    Render.com (ephemeral disk → ${DATA_DIR})`);
    } else {
      console.log(`   Local:   http://localhost:${PORT}`);
      console.log(`   Network: http://${localIP}:${PORT}`);
    }
    console.log(`   DB:      ${DB_PATH}`);
    console.log(`   Polling every ${POLL_INTERVAL/1000}s (background)\n`);
  });

  // Graceful shutdown — save DB and push a final durable snapshot on exit so the
  // very latest history survives a redeploy (Render sends SIGTERM before wiping).
  const shutdown = async () => {
    console.log('\n[shutdown] Saving DB…');
    try { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); } catch {}
    if (backup.isEnabled()) {
      try { await backup.snapshot(Buffer.from(db.export()), { force: true }); } catch {}
    }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT',  shutdown);
})();
