'use strict';

/**
 * Oʻahu TheBus (OTS) live AVL via api.thebus.org AppID.
 *
 * Official docs (read in full):
 *   https://hea.thebus.org/api_info.asp
 *   https://hea.thebus.org/api/documentation/Web%20Services%20API.pdf
 *   + arrivals / vehicle / route (+ JSON) endpoint PDFs
 *
 * Endpoints used (all require ?key=APPID):
 *   GET /vehicle/?key=…[&num=VEHICLE]     — fleet (omit num) or one bus
 *   GET /arrivalsJSON/?key=…&stop=STOP    — live/scheduled arrivals at a stop
 *   GET /routeJSON/?key=…&route=ROUTE     — shape IDs + headsigns for a route
 *   Static GTFS zip (keyless)             — routes, stops, shapes geometry
 *
 * Env: THEBUS_APP_ID (or THEBUS_API_KEY / OTS_APP_ID)
 * Quota: 250,000 requests/day per AppID (OTS default).
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { URL } = require('url');

const HOST = 'api.thebus.org';
const GTFS_URL = 'https://www.thebus.org/transitdata/production/google_transit.zip';
const VEHICLE_STALE_MS = 5 * 60 * 1000;
const VEHICLE_RETAIN_MS = 48 * 60 * 60 * 1000;
const POLL_MIN_GAP_MS = 12 * 1000;
const ARRIVAL_CACHE_MS = 30 * 1000;
const ROUTE_META_TTL_MS = 6 * 60 * 60 * 1000;
const GTFS_REFRESH_MS = 24 * 60 * 60 * 1000;
const ATTRIBUTION = 'Route and arrival data provided by permission of Oahu Transit Services, Inc';

const OAHU_DEF = {
  id: 'oahu',
  name: 'Oʻahu',
  short: 'Oʻahu',
  emoji: '🏙️',
  host: 'api.thebus.org',
  agency: 'TheBus (DTS / OTS)',
  url: 'https://www.thebus.org/',
  available: true,
  provider: 'thebus',
  bbox: { minLat: 21.2, maxLat: 21.75, minLon: -158.3, maxLon: -157.6 },
  mapCenter: [-157.8583, 21.3099],
  mapZoom: 10,
  attribution: ATTRIBUTION,
  registerUrl: 'http://api.thebus.org/NewAccount',
  docs: [
    { label: 'OTS Web API overview', url: 'https://hea.thebus.org/api_info.asp' },
    { label: 'Web Services API (PDF)', url: 'https://hea.thebus.org/api/documentation/Web%20Services%20API.pdf' },
  ],
};

function resolveAppId() {
  return process.env.THEBUS_APP_ID
    || process.env.THEBUS_API_KEY
    || process.env.OTS_APP_ID
    || '';
}

function isConfigured() {
  return !!resolveAppId();
}

function inBbox(lat, lon, bbox) {
  return lat >= bbox.minLat && lat <= bbox.maxLat && lon >= bbox.minLon && lon <= bbox.maxLon;
}

function hashColor(s) {
  let h = 0;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  const sat = 55 + (Math.abs(h) % 25);
  const light = 42 + (Math.abs(h >> 8) % 12);
  return hslToHex(hue, sat, light);
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = n => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function normalizeColor(c, fallbackKey) {
  if (c && String(c).replace(/^#+/, '').length >= 3) {
    return '#' + String(c).replace(/^#+/, '');
  }
  return hashColor(fallbackKey || 'route');
}

function parseOahuTs(s) {
  if (!s) return null;
  // OTS timestamps look like "12/27/2022 2:25:11 PM" in Pacific/Honolulu (no TZ).
  const m = String(s).trim().match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i
  );
  if (!m) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  let hour = parseInt(m[4], 10);
  const ampm = m[7].toUpperCase();
  if (ampm === 'PM' && hour < 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  // Wall clock is HST (UTC−10, no DST). Date.UTC treats components as UTC, so
  // add 10h to convert Honolulu wall time → true UTC epoch.
  const utcGuess = Date.UTC(+m[3], +m[1] - 1, +m[2], hour, +m[5], +m[6]);
  return utcGuess + 10 * 60 * 60 * 1000;
}

function httpGet(urlStr, { timeoutMs = 15000, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const t0 = Date.now();
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'User-Agent': 'HeleonTracker/1.0 (TheBus OTS AppID client; https://bus-tracker-a36o.onrender.com)',
        Accept: 'application/json, application/xml, text/xml, */*',
      },
      timeout: timeoutMs,
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          body: binary ? buf : buf.toString('utf8'),
          latency: Date.now() - t0,
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function xmlTag(body, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = String(body || '').match(re);
  return m ? m[1].trim() : null;
}

function xmlTags(body, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(String(body || '')))) out.push(m[1]);
  return out;
}

function parseVehicleXml(body) {
  const err = xmlTag(body, 'errorMessage');
  if (err) return { error: err, vehicles: [], timestamp: xmlTag(body, 'timestamp') };
  const vehicles = xmlTags(body, 'vehicle').map(block => ({
    number: xmlTag(block, 'number'),
    trip: xmlTag(block, 'trip'),
    driver: xmlTag(block, 'driver'),
    latitude: xmlTag(block, 'latitude'),
    longitude: xmlTag(block, 'longitude'),
    adherence: xmlTag(block, 'adherence'),
    last_message: xmlTag(block, 'last_message'),
    route_short_name: xmlTag(block, 'route_short_name'),
    headsign: xmlTag(block, 'headsign'),
  })).filter(v => v.number);
  return { vehicles, timestamp: xmlTag(body, 'timestamp'), error: null };
}

function parseJsonSafe(body) {
  try { return JSON.parse(body); } catch { return null; }
}

function csvParse(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const cols = splitCsvLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = cols[i] != null ? cols[i] : ''; });
    return row;
  });
}

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function createTheBusPoller(opts = {}) {
  const dataDir = opts.dataDir || path.join(__dirname, 'data');
  const zipPath = path.join(dataDir, 'thebus-gtfs.zip');
  const appId = () => resolveAppId();

  const state = {
    routes: [],
    routeMap: {},
    shapes: [],
    shapesLoaded: false,
    stops: [],
    stopById: {},
    shapeCoords: {}, // shape_id -> [[lon,lat],...]
    latestVehicles: [],
    lastPollStats: { ts: null, total: 0 },
    lastGoodVehicle: {},
    lastError: null,
    gtfsMeta: { lastFetch: null, routes: 0, stops: 0, shapes: 0 },
    arrivalCache: new Map(), // stopId -> { ts, data }
    routeApiCache: new Map(), // routeNum -> { ts, data }
    requestCountToday: 0,
    requestDay: null,
    lastFleetPoll: 0,
  };

  function bumpQuota() {
    const day = new Date().toISOString().slice(0, 10);
    if (state.requestDay !== day) { state.requestDay = day; state.requestCountToday = 0; }
    state.requestCountToday++;
  }

  async function apiGet(pathname, params = {}) {
    const key = appId();
    if (!key) throw new Error('THEBUS_APP_ID not set');
    const q = new URLSearchParams({ key, ...params });
    const url = `http://${HOST}${pathname}?${q}`;
    bumpQuota();
    const res = await httpGet(url);
    if (res.status !== 200) throw new Error(`TheBus ${pathname} HTTP ${res.status}`);
    return res;
  }

  async function fetchFleetXml() {
    // Omit num → full AVL fleet (docs list num as optional in practice; verified
    // that the endpoint accepts the call without it and returns <vehicles>).
    const res = await apiGet('/vehicle/');
    return parseVehicleXml(res.body);
  }

  async function fetchVehicle(num) {
    const res = await apiGet('/vehicle/', { num: String(num) });
    return parseVehicleXml(res.body);
  }

  async function fetchArrivals(stopId) {
    const sid = String(stopId);
    const cached = state.arrivalCache.get(sid);
    if (cached && Date.now() - cached.ts < ARRIVAL_CACHE_MS) return cached.data;
    const res = await apiGet('/arrivalsJSON/', { stop: sid });
    const j = parseJsonSafe(res.body);
    if (!j) throw new Error('arrivalsJSON parse failed');
    if (j.errorMessage) throw new Error(j.errorMessage);
    const arrivals = (j.arrivals || j.arrival || []).map(a => ({
      id: a.id,
      trip: a.trip,
      route: a.route,
      headsign: a.headsign,
      vehicle: a.vehicle,
      direction: a.direction,
      stopTime: a.stopTime,
      date: a.date || a.Date,
      estimated: a.estimated === '1' || a.estimated === 1,
      canceled: String(a.canceled || '0'),
      latitude: a.latitude != null ? parseFloat(a.latitude) : null,
      longitude: a.longitude != null ? parseFloat(a.longitude) : null,
      shape: a.shape || null,
    }));
    const data = {
      stop: j.stop || sid,
      timestamp: j.timestamp || null,
      arrivals,
      attribution: ATTRIBUTION,
    };
    state.arrivalCache.set(sid, { ts: Date.now(), data });
    return data;
  }

  async function fetchRouteMeta(routeNum) {
    const key = String(routeNum);
    const cached = state.routeApiCache.get(key);
    if (cached && Date.now() - cached.ts < ROUTE_META_TTL_MS) return cached.data;
    const res = await apiGet('/routeJSON/', { route: key });
    const j = parseJsonSafe(res.body);
    if (!j) throw new Error('routeJSON parse failed');
    if (j.errorMessage) throw new Error(j.errorMessage);
    const variants = (j.route || []).map(r => ({
      routeNum: r.routeNum || key,
      shapeID: r.shapeID || r.shapeId,
      firstStop: r.firstStop || null,
      headsign: r.headsign || null,
    }));
    const data = {
      routeName: j.routeName || key,
      routeID: j.routeID || j.routeId || null,
      variants,
    };
    state.routeApiCache.set(key, { ts: Date.now(), data });
    return data;
  }

  function unzipText(file) {
    return execSync(`unzip -p "${zipPath}" ${file}`, {
      maxBuffer: 80 * 1024 * 1024,
      encoding: 'utf8',
    });
  }

  async function ensureGtfs(force = false) {
    const age = state.gtfsMeta.lastFetch ? Date.now() - state.gtfsMeta.lastFetch : Infinity;
    if (!force && state.shapesLoaded && age < GTFS_REFRESH_MS) return;
    fs.mkdirSync(dataDir, { recursive: true });
    const needDownload = force || !fs.existsSync(zipPath)
      || (Date.now() - fs.statSync(zipPath).mtimeMs) > GTFS_REFRESH_MS;
    if (needDownload) {
      console.log('[thebus] downloading static GTFS…');
      const res = await httpGet(GTFS_URL, { binary: true, timeoutMs: 120000 });
      if (res.status !== 200 || !res.body || res.body.length < 10000) {
        throw new Error(`GTFS download failed HTTP ${res.status}`);
      }
      fs.writeFileSync(zipPath, res.body);
    }

    const routeRows = csvParse(unzipText('routes.txt'));
    const stopRows = csvParse(unzipText('stops.txt'));
    const shapeRows = csvParse(unzipText('shapes.txt'));

    const routes = routeRows
      .filter(r => String(r.agency_id || 'TheBus') === 'TheBus' || !r.agency_id)
      .map(r => {
        const short = r.route_short_name || r.route_id;
        return {
          id: short,
          gtfsRouteId: r.route_id,
          name: r.route_long_name || short,
          short,
          color: normalizeColor(r.route_color, short),
          island: 'oahu',
          type: parseInt(r.route_type, 10) || 3,
        };
      });
    // Prefer unique short names; if collision, keep first.
    const byShort = new Map();
    for (const r of routes) if (!byShort.has(r.short)) byShort.set(r.short, r);
    state.routes = [...byShort.values()];
    state.routeMap = Object.fromEntries(state.routes.map(r => [r.id, r]));

    state.stops = stopRows.map(s => ({
      id: s.stop_id,
      stopCode: s.stop_code || s.stop_id,
      name: s.stop_name,
      lat: parseFloat(s.stop_lat),
      lon: parseFloat(s.stop_lon),
      island: 'oahu',
    })).filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lon));
    state.stopById = Object.fromEntries(state.stops.map(s => [String(s.id), s]));

    const shapeCoords = {};
    for (const row of shapeRows) {
      const sid = row.shape_id;
      const lat = parseFloat(row.shape_pt_lat);
      const lon = parseFloat(row.shape_pt_lon);
      const seq = parseInt(row.shape_pt_sequence, 10) || 0;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      (shapeCoords[sid] = shapeCoords[sid] || []).push({ seq, lon, lat });
    }
    state.shapeCoords = {};
    for (const [sid, pts] of Object.entries(shapeCoords)) {
      pts.sort((a, b) => a.seq - b.seq);
      state.shapeCoords[sid] = pts.map(p => [p.lon, p.lat]);
    }

    // Build pattern rows for /api/shapes — one entry per shape_id, keyed by route short name.
    // Prefer live routeJSON shape IDs when we have them; otherwise attach all GTFS shapes
    // whose id starts with the route short name (TheBus convention: "1L0090", "540232").
    const shapes = [];
    for (const route of state.routes) {
      const live = state.routeApiCache.get(route.short);
      const shapeIds = new Set();
      if (live && live.data && live.data.variants) {
        for (const v of live.data.variants) if (v.shapeID) shapeIds.add(v.shapeID);
      }
      if (!shapeIds.size) {
        const prefix = route.short;
        for (const sid of Object.keys(state.shapeCoords)) {
          if (sid === prefix || sid.startsWith(prefix)) shapeIds.add(sid);
        }
      }
      let i = 0;
      for (const sid of shapeIds) {
        const coords = state.shapeCoords[sid];
        if (!coords || coords.length < 2) continue;
        shapes.push({
          route_id: route.id,
          pattern_id: sid,
          name: route.name,
          direction: null,
          color: route.color,
          shape: coords,
          segments: [coords],
          island: 'oahu',
          headsign: (live && live.data && live.data.variants.find(v => v.shapeID === sid) || {}).headsign || null,
        });
        i++;
        if (i >= 8) break; // cap patterns per route for map perf
      }
    }
    state.shapes = shapes;
    state.shapesLoaded = shapes.length > 0;
    state.gtfsMeta = {
      lastFetch: Date.now(),
      routes: state.routes.length,
      stops: state.stops.length,
      shapes: Object.keys(state.shapeCoords).length,
      patterns: shapes.length,
    };
    console.log(`[thebus] GTFS loaded: ${state.routes.length} routes, ${state.stops.length} stops, ${state.gtfsMeta.shapes} shapes → ${shapes.length} patterns`);
  }

  function cleanStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === 'null' || s === 'undefined' || s === 'None' || s === '???') return null;
  return s;
}

function normalizeVehicle(raw, ts) {
  const id = cleanStr(raw.number);
  if (!id) return null;
  const lat = parseFloat(raw.latitude);
  const lon = parseFloat(raw.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (!inBbox(lat, lon, OAHU_DEF.bbox)) return null;
  const luMs = parseOahuTs(raw.last_message) || ts;
  if ((ts - luMs) > VEHICLE_RETAIN_MS) return null;
  const routeShort = cleanStr(raw.route_short_name);
  const route = routeShort ? state.routeMap[routeShort] : null;
  const adherenceRaw = cleanStr(raw.adherence);
  const adherence = adherenceRaw != null ? parseInt(adherenceRaw, 10) : null;
  const ageMin = (() => {
    let a = (ts - luMs) / 60000;
    if (a < 0) a = a > -180 ? 0 : a;
    return Math.round(a * 10) / 10;
  })();
  return {
    id,
    island: 'oahu',
    name: id,
    lat,
    lon,
    speed: null,
    headingDegrees: null,
    heading: null,
    passengerLoad: null,
    capacity: null,
    shapeDistanceTraveled: null,
    patternId: null,
    tripId: cleanStr(raw.trip),
    headsign: cleanStr(raw.headsign),
    direction: null,
    shapeId: null,
    vehicleTs: luMs,
    ageMin,
    stale: (ts - luMs) > VEHICLE_STALE_MS && (ts - luMs) > 0,
    lastUpdated: new Date(luMs).toISOString(),
    lastMessage: cleanStr(raw.last_message),
    routeId: routeShort,
    unassigned: !routeShort,
    routeName: route ? route.name : (routeShort ? `Route ${routeShort}` : 'Not in service'),
    routeShort: routeShort || '—',
    routeColor: route ? route.color : '#8b949e',
    adherence: Number.isFinite(adherence) ? adherence : null,
    occupancyStatus: null,
    gtfsCurrentStatus: null,
    congestionLevel: null,
    attribution: ATTRIBUTION,
  };
}

  async function poll() {
    if (!appId()) {
      state.lastError = 'THEBUS_APP_ID not set';
      return [];
    }
    const now = Date.now();
    if (now - state.lastFleetPoll < POLL_MIN_GAP_MS && state.latestVehicles.length) {
      return state.latestVehicles;
    }
    state.lastFleetPoll = now;
    if (!state.shapesLoaded) {
      try { await ensureGtfs(); } catch (e) { state.lastError = e.message; }
    }
    try {
      const feed = await fetchFleetXml();
      if (feed.error) throw new Error(feed.error);
      const vehicles = [];
      const seen = new Set();
      for (const raw of feed.vehicles) {
        const v = normalizeVehicle(raw, now);
        if (!v) continue;
        vehicles.push(v);
        seen.add(v.id);
        state.lastGoodVehicle[v.id] = v;
      }
      for (const v of Object.values(state.lastGoodVehicle)) {
        if (seen.has(v.id)) continue;
        if ((now - v.vehicleTs) > VEHICLE_RETAIN_MS) { delete state.lastGoodVehicle[v.id]; continue; }
        vehicles.push(Object.assign({}, v, {
          stale: true,
          ageMin: Math.round(((now - v.vehicleTs) / 60000) * 10) / 10,
        }));
      }
      state.latestVehicles = vehicles;
      state.lastPollStats = { ts: now, total: vehicles.length };
      state.lastError = null;
      return vehicles;
    } catch (e) {
      state.lastError = e.message;
      return state.latestVehicles;
    }
  }

  async function getFleet() {
    await poll();
    const now = Date.now();
    const fleet = state.latestVehicles.map(v => {
      let status, reason;
      if (v.ageMin == null) { status = 'unknown'; reason = 'No GPS timestamp'; }
      else if (v.ageMin < 5 && !v.unassigned) { status = 'live'; reason = 'Reporting now'; }
      else if (v.ageMin < 5) { status = 'idle'; reason = 'Fresh GPS but no route'; }
      else if (v.ageMin < 60) { status = 'recent'; reason = `Last seen ${Math.round(v.ageMin)} min ago`; }
      else if (v.ageMin < 1440) { status = 'offshift'; reason = `Last seen ${Math.round(v.ageMin / 60)} h ago`; }
      else { status = 'dormant'; reason = `Last seen ${Math.round(v.ageMin / 1440)} d ago`; }
      return {
        id: v.id,
        island: 'oahu',
        name: v.name,
        status,
        reason,
        onMap: status === 'live',
        lat: v.lat,
        lon: v.lon,
        speed: v.speed,
        heading: v.heading,
        headingDegrees: v.headingDegrees,
        passengerLoad: v.passengerLoad,
        capacity: v.capacity,
        patternId: v.patternId,
        shapeDistanceTraveled: v.shapeDistanceTraveled,
        routeId: v.routeId,
        routeShort: v.routeShort,
        routeName: v.routeName,
        routeColor: v.routeColor,
        tripId: v.tripId,
        headsign: v.headsign,
        adherence: v.adherence,
        lastUpdated: v.lastUpdated,
        ageMin: v.ageMin,
      };
    });
    const rank = { live: 0, idle: 1, recent: 2, offshift: 3, dormant: 4, unknown: 5 };
    fleet.sort((a, b) => (rank[a.status] - rank[b.status]) || ((a.ageMin ?? 1e9) - (b.ageMin ?? 1e9)));
    const counts = fleet.reduce((m, f) => { m[f.status] = (m[f.status] || 0) + 1; return m; }, {});
    return { ts: now, total: fleet.length, counts, fleet, island: 'oahu', attribution: ATTRIBUTION };
  }

  async function enrichActiveRoutes() {
    // Pull routeJSON for routes currently in service so shape IDs / headsigns
    // match live AVL (still within the 250k/day budget — one call per active route).
    const active = new Set(state.latestVehicles.map(v => v.routeId).filter(Boolean));
    let n = 0;
    for (const rid of active) {
      if (n >= 25) break;
      try {
        await fetchRouteMeta(rid);
        n++;
      } catch { /* keep GTFS shapes */ }
      await new Promise(r => setTimeout(r, 80));
    }
    if (n) {
      try { await ensureGtfs(false); } catch { /* ignore */ }
      // Rebuild shapes with freshly cached routeJSON variants
      const shapes = [];
      for (const route of state.routes) {
        const live = state.routeApiCache.get(route.short);
        const shapeIds = new Set();
        if (live && live.data && live.data.variants) {
          for (const v of live.data.variants) if (v.shapeID) shapeIds.add(v.shapeID);
        }
        if (!shapeIds.size) {
          for (const sid of Object.keys(state.shapeCoords)) {
            if (sid === route.short || sid.startsWith(route.short)) shapeIds.add(sid);
          }
        }
        let i = 0;
        for (const sid of shapeIds) {
          const coords = state.shapeCoords[sid];
          if (!coords || coords.length < 2) continue;
          shapes.push({
            route_id: route.id,
            pattern_id: sid,
            name: route.name,
            direction: null,
            color: route.color,
            shape: coords,
            segments: [coords],
            island: 'oahu',
            headsign: (live && live.data && live.data.variants.find(v => v.shapeID === sid) || {}).headsign || null,
          });
          if (++i >= 8) break;
        }
      }
      if (shapes.length) state.shapes = shapes;
    }
  }

  return {
    def: OAHU_DEF,
    state,
    isConfigured,
    ensureGtfs,
    poll,
    getFleet,
    fetchArrivals,
    fetchRouteMeta,
    fetchVehicle,
    enrichActiveRoutes,
    getRoutes: () => state.routes,
    getShapes: () => state.shapes,
    getStops: () => state.stops,
    getStop: (id) => state.stopById[String(id)] || null,
    getVehicles: () => state.latestVehicles,
    getStats: () => state.lastPollStats,
    getApiInfo: () => ({
      island: 'oahu',
      host: HOST,
      agency: OAHU_DEF.agency,
      provider: 'thebus',
      configured: isConfigured(),
      attribution: ATTRIBUTION,
      endpoints: {
        vehicle: `http://${HOST}/vehicle/?key=APPID`,
        arrivalsJSON: `http://${HOST}/arrivalsJSON/?key=APPID&stop=STOP`,
        routeJSON: `http://${HOST}/routeJSON/?key=APPID&route=ROUTE`,
        gtfs: GTFS_URL,
      },
      routes: state.routes.length,
      shapes: state.shapes.length,
      stops: state.stops.length,
      vehicles: state.latestVehicles.length,
      lastPollTs: state.lastPollStats.ts,
      lastError: state.lastError,
      requestsToday: state.requestCountToday,
      gtfs: state.gtfsMeta,
    }),
  };
}

module.exports = {
  createTheBusPoller,
  resolveAppId,
  isConfigured,
  OAHU_DEF,
  ATTRIBUTION,
  parseOahuTs,
  parseVehicleXml,
};
