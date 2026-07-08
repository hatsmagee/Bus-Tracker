/**
 * Multi-island Syncromatics transit polling (keyless GTFS-RT + RTPI).
 * Kauaʻi (thekauaibus.com) and Maui (mauibus.org) share the same platform as
 * Hele-On (myheleonbus.org). Big Island keeps its dedicated pipeline in
 * heleon-server.js (road snapping, transformer, SQLite history).
 */

const https = require('https');
const { parseFeedMessage } = require('./gtfs-rt');

const VEHICLE_STALE_MS = 5 * 60 * 1000;
const VEHICLE_RETAIN_MS = 48 * 60 * 60 * 1000;
const ROUTE_MEMORY_MS = 6 * 60 * 60 * 1000;

const ISLAND_DEFS = {
  kauai: {
    id: 'kauai',
    name: 'Kauaʻi',
    short: 'Kauaʻi',
    emoji: '🌺',
    host: 'thekauaibus.com',
    agency: 'The Kauai Bus',
    url: 'https://www.thekauaibus.com/',
    bbox: { minLat: 21.85, maxLat: 22.25, minLon: -159.85, maxLon: -159.25 },
    mapCenter: [-159.46, 22.05],
    mapZoom: 9.5,
    api: {
      rtpi: '/api/rtpi?path=',
      gtfs: '/gtfs',
      vp: '/gtfs-rt/vehiclepositions',
      tu: '/gtfs-rt/tripupdates',
      alerts: '/gtfs-rt/alerts',
    },
  },
  maui: {
    id: 'maui',
    name: 'Maui',
    short: 'Maui',
    emoji: '🏝️',
    host: 'mauibus.org',
    agency: 'Maui Bus',
    url: 'https://www.mauibus.org/',
    bbox: { minLat: 20.55, maxLat: 21.05, minLon: -156.7, maxLon: -155.95 },
    mapCenter: [-156.33, 20.80],
    mapZoom: 9,
    api: {
      rtpi: '/api/rtpi?path=',
      gtfs: '/gtfs',
      vp: '/gtfs-rt/vehiclepositions',
      tu: '/gtfs-rt/tripupdates',
      alerts: '/gtfs-rt/alerts',
    },
  },
};

function parseFleetTs(s) {
  if (!s) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) { const t = Date.parse(s); return Number.isNaN(t) ? null : t; }
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] + 10, +m[5], +m[6]);
}

function inBbox(lat, lon, bbox) {
  return lat >= bbox.minLat && lat <= bbox.maxLat && lon >= bbox.minLon && lon <= bbox.maxLon;
}

function normalizeColor(c) {
  if (!c) return '#888888';
  const s = String(c).replace(/^#+/, '');
  return s.length >= 3 ? `#${s}` : '#888888';
}

function httpsGet(host, path, binary) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = https.request({
      hostname: host,
      path,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: `https://${host}/` },
      timeout: 10000,
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          body: binary ? body : body.toString('utf8'),
          latency: Date.now() - t0,
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function createIslandPoller(def) {
  const state = {
    routes: [],
    routeMap: {},
    shapes: [],
    shapesLoaded: false,
    latestVehicles: [],
    lastPollStats: { ts: null, total: 0 },
    lastGoodVehicle: {},
    lastKnownRoute: {},
    tripUpdateIndex: {},
    vehicleTripMap: {},
    vpBearing: {},
    vpTripMap: {},
    vpStatus: {},
    pollLog: [],
    lastError: null,
    gtfsMeta: { lastFetch: null, routes: 0, stops: 0 },
    alerts: [],
  };

  async function rtpi(path) {
    const res = await httpsGet(def.host, `${def.api.rtpi}${encodeURIComponent(path)}`, false);
    if (res.status !== 200) throw new Error(`RTPI ${path}: HTTP ${res.status}`);
    return JSON.parse(res.body);
  }

  async function fetchBinary(path) {
    return httpsGet(def.host, path, true);
  }

  async function loadRoutes() {
    try {
      const routes = await rtpi('routes');
      if (!Array.isArray(routes)) return;
      state.routes = routes.map(r => ({
        id: r.id,
        name: r.name || r.shortName || String(r.id),
        short: r.shortName || String(r.id),
        color: normalizeColor(r.color),
        island: def.id,
      }));
      state.routeMap = Object.fromEntries(state.routes.map(r => [r.id, r]));
    } catch (e) {
      state.lastError = e.message;
    }
  }

  async function loadShapes() {
    if (!state.routes.length) await loadRoutes();
    const rows = [];
    for (const route of state.routes) {
      try {
        const patterns = await rtpi(`routes/${route.id}/patterns`);
        if (!Array.isArray(patterns)) continue;
        patterns.forEach(p => {
          rows.push({
            route_id: route.id,
            pattern_id: p.id,
            name: p.name || route.name,
            direction: p.directionType || null,
            color: normalizeColor(p.color || route.color),
            shape: p.shape || null,
            island: def.id,
          });
        });
      } catch (e) { /* skip route */ }
      await new Promise(r => setTimeout(r, 120));
    }
    if (rows.length) {
      state.shapes = rows;
      state.shapesLoaded = true;
    }
  }

  async function pollTripUpdates() {
    try {
      const res = await fetchBinary(def.api.tu);
      if (res.status !== 200 || !res.body.length) return;
      const feed = parseFeedMessage(res.body);
      const idx = {};
      const tripMap = {};
      const now = Date.now();
      feed.forEach(e => {
        const tu = e.tripUpdate;
        if (!tu || !tu.trip || !tu.trip.tripId) return;
        const byStop = {};
        (tu.stopTimeUpdates || []).forEach(s => {
          const t = (s.arrival && s.arrival.time) || (s.departure && s.departure.time);
          if (t && s.stopId) byStop[s.stopId] = { ms: t * 1000, seq: s.stopSeq };
        });
        idx[tu.trip.tripId] = byStop;
        if (tu.vehicleId) {
          const id = parseInt(tu.vehicleId, 10) || tu.vehicleId;
          const times = (tu.stopTimeUpdates || []).map(s => s.arrival && s.arrival.time).filter(Boolean).map(t => t * 1000);
          if (times.length) {
            const firstMs = Math.min(...times), lastMs = Math.max(...times);
            const score = now >= firstMs && now <= lastMs ? 0 : Math.min(Math.abs(firstMs - now), Math.abs(lastMs - now));
            const prev = tripMap[id];
            if (!prev || score < prev._score) tripMap[id] = { tripId: tu.trip.tripId, _score: score };
          }
        }
      });
      state.tripUpdateIndex = idx;
      state.vehicleTripMap = tripMap;
    } catch (e) { state.lastError = e.message; }
  }

  async function pollVehiclePositions() {
    try {
      const res = await fetchBinary(def.api.vp);
      if (res.status !== 200 || !res.body.length) return;
      const feed = parseFeedMessage(res.body);
      const now = Date.now();
      const nextTrip = {};
      feed.forEach(e => {
        const vp = e.vehicle;
        if (!vp || !vp.vehicleId) return;
        const id = parseInt(vp.vehicleId, 10) || vp.vehicleId;
        const tripId = vp.trip && vp.trip.tripId;
        if (tripId) nextTrip[id] = tripId;
        if (vp.bearing != null && vp.timestamp && (now - vp.timestamp * 1000) < VEHICLE_STALE_MS) {
          state.vpBearing[id] = { bearing: Math.round(vp.bearing), ts: vp.timestamp * 1000 };
        }
        if (vp.timestamp && (now - vp.timestamp * 1000) < VEHICLE_STALE_MS) {
          state.vpStatus[id] = {
            occupancyStatus: vp.occupancyStatus != null ? vp.occupancyStatus : null,
            currentStatus: vp.currentStatus != null ? vp.currentStatus : null,
            congestionLevel: vp.congestionLevel != null ? vp.congestionLevel : null,
            ts: vp.timestamp * 1000,
          };
        }
      });
      state.vpTripMap = nextTrip;
    } catch (e) { state.lastError = e.message; }
  }

  async function pollFleet() {
    const ts = Date.now();
    if (!state.routes.length) await loadRoutes();
    const byId = {};

    const results = await Promise.all(state.routes.map(async route => {
      try {
        const list = await rtpi(`routes/${route.id}/vehicles`);
        return { rid: route.id, list: Array.isArray(list) ? list : [], status: 200 };
      } catch {
        return { rid: route.id, list: [], status: 0 };
      }
    }));

    results.forEach(r => {
      r.list.forEach(raw => {
        if (raw.lat == null || raw.lon == null) return;
        if (!inBbox(raw.lat, raw.lon, def.bbox)) return;
        const luMs = raw.lastUpdated ? parseFleetTs(raw.lastUpdated) : ts;
        if (!luMs || (ts - luMs) > VEHICLE_RETAIN_MS) return;
        const prev = byId[raw.id];
        if (!prev || luMs > prev._luMs || (luMs === prev._luMs && (raw.speed || 0) > (prev.speed || 0))) {
          byId[raw.id] = Object.assign({}, raw, { _routeId: r.rid, _luMs: luMs });
        }
        if ((ts - luMs) < VEHICLE_STALE_MS) state.lastKnownRoute[raw.id] = { routeId: r.rid, ts };
      });
      state.pollLog.push({ ts, routeId: r.rid, status: r.status, count: r.list.length });
      if (state.pollLog.length > 200) state.pollLog.splice(0, state.pollLog.length - 200);
    });

    try {
      const roster = await rtpi('vehicles');
      if (Array.isArray(roster)) roster.forEach(raw => {
        if (byId[raw.id]) return;
        if (raw.lat == null || raw.lon == null) return;
        if (!inBbox(raw.lat, raw.lon, def.bbox)) return;
        const luMs = raw.lastUpdated ? parseFleetTs(raw.lastUpdated) : ts;
        if (!luMs || (ts - luMs) > VEHICLE_RETAIN_MS) return;
        const mem = state.lastKnownRoute[raw.id];
        const routeId = mem && (ts - mem.ts) < ROUTE_MEMORY_MS ? mem.routeId : null;
        byId[raw.id] = Object.assign({}, raw, { _routeId: routeId, _luMs: luMs, _unassigned: true });
      });
    } catch {}

    const vehicles = [];
    Object.values(byId).forEach(raw => {
      const id = raw.id;
      const luMs = raw._luMs;
      const routeId = raw._routeId;
      const route = state.routeMap[routeId];
      const tripId = (state.vehicleTripMap[id] && state.vehicleTripMap[id].tripId) || state.vpTripMap[id] || null;
      const brg = state.vpBearing[id] && (ts - state.vpBearing[id].ts) < VEHICLE_STALE_MS ? state.vpBearing[id].bearing
        : (raw.headingDegrees != null ? Math.round(raw.headingDegrees) : null);
      const st = state.vpStatus[id] && (ts - state.vpStatus[id].ts) < VEHICLE_STALE_MS ? state.vpStatus[id] : null;
      const v = {
        id,
        island: def.id,
        name: raw.name || String(id),
        lat: raw.lat,
        lon: raw.lon,
        speed: raw.speed != null ? raw.speed : null,
        headingDegrees: brg,
        heading: raw.heading || null,
        passengerLoad: raw.passengerLoad != null ? raw.passengerLoad : 0,
        capacity: raw.capacity != null ? raw.capacity : null,
        shapeDistanceTraveled: raw.shapeDistanceTraveled || 0,
        patternId: raw.patternId || null,
        tripId,
        headsign: null,
        direction: null,
        shapeId: null,
        vehicleTs: luMs,
        ageMin: (() => { let a = (ts - luMs) / 60000; if (a < 0) a = a > -180 ? 0 : a; return Math.round(a * 10) / 10; })(),
        stale: (ts - luMs) > VEHICLE_STALE_MS && (ts - luMs) > 0,
        lastUpdated: new Date(luMs).toISOString(),
        routeId,
        unassigned: !!raw._unassigned,
        routeName: route ? route.name : 'Not in service',
        routeShort: route ? route.short : '—',
        routeColor: route ? route.color : '#8b949e',
        occupancyStatus: st ? st.occupancyStatus : null,
        gtfsCurrentStatus: st ? st.currentStatus : null,
        congestionLevel: st ? st.congestionLevel : null,
      };
      vehicles.push(v);
      state.lastGoodVehicle[id] = v;
    });

    const seen = new Set(vehicles.map(v => v.id));
    Object.values(state.lastGoodVehicle).forEach(v => {
      if (seen.has(v.id)) return;
      if ((ts - v.vehicleTs) > VEHICLE_RETAIN_MS) { delete state.lastGoodVehicle[v.id]; return; }
      vehicles.push(Object.assign({}, v, {
        stale: true,
        ageMin: Math.round(((ts - v.vehicleTs) / 60000) * 10) / 10,
      }));
    });

    return vehicles;
  }

  async function poll() {
    await Promise.all([
      pollTripUpdates().catch(() => {}),
      pollVehiclePositions().catch(() => {}),
    ]);
    const vehicles = await pollFleet().catch(() => []);
    state.latestVehicles = vehicles;
    state.lastPollStats = { ts: Date.now(), total: vehicles.length };
    state.lastError = null;
    return vehicles;
  }

  async function getFleet() {
    const now = Date.now();
    if (!state.routes.length) await loadRoutes();
    let roster = [];
    try { roster = await rtpi('vehicles'); } catch {}
    if (!Array.isArray(roster)) roster = [];

    const liveByRoute = {};
    await Promise.all(state.routes.map(async route => {
      try {
        const vs = await rtpi(`routes/${route.id}/vehicles`);
        if (!Array.isArray(vs)) return;
        vs.forEach(v => {
          const t = parseFleetTs(v.lastUpdated);
          const prev = liveByRoute[v.id];
          if (!prev || (t && t > prev._t)) liveByRoute[v.id] = Object.assign({}, v, { routeId: route.id, _t: t || 0 });
        });
      } catch {}
    }));

    const fleet = roster.map(r => {
      const live = liveByRoute[r.id];
      const src = live || r;
      const luMs = parseFleetTs(src.lastUpdated);
      let ageMin = luMs ? (now - luMs) / 60000 : null;
      if (ageMin != null && ageMin < 0) ageMin = ageMin > -180 ? 0 : null;
      const inBox = src.lat != null && inBbox(src.lat, src.lon, def.bbox);
      const routeId = live ? live.routeId : null;
      const route = state.routeMap[routeId];
      const tripId = (state.vehicleTripMap[r.id] && state.vehicleTripMap[r.id].tripId) || state.vpTripMap[r.id] || null;
      let status, reason;
      if (ageMin == null) { status = 'unknown'; reason = 'No GPS timestamp'; }
      else if (ageMin < 5 && live) { status = 'live'; reason = 'Reporting now'; }
      else if (ageMin < 5) { status = 'idle'; reason = 'Fresh GPS but not assigned to a route'; }
      else if (ageMin < 60) { status = 'recent'; reason = `Last seen ${Math.round(ageMin)} min ago`; }
      else if (ageMin < 1440) { status = 'offshift'; reason = `Last seen ${Math.round(ageMin / 60)} h ago`; }
      else { status = 'dormant'; reason = `Last seen ${Math.round(ageMin / 1440)} d ago`; }
      if (!inBox && src.lat != null) reason = `Outside ${def.short}`;
      return {
        id: r.id,
        island: def.id,
        name: r.name || String(r.id),
        status,
        reason,
        onMap: status === 'live',
        lat: src.lat ?? null,
        lon: src.lon ?? null,
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
        routeColor: route ? route.color : null,
        tripId,
        lastUpdated: src.lastUpdated || null,
        ageMin: ageMin != null ? Math.round(ageMin * 10) / 10 : null,
      };
    });

    const rank = { live: 0, idle: 1, recent: 2, offshift: 3, dormant: 4, unknown: 5 };
    fleet.sort((a, b) => (rank[a.status] - rank[b.status]) || ((a.ageMin ?? 1e9) - (b.ageMin ?? 1e9)));
    const counts = fleet.reduce((m, f) => { m[f.status] = (m[f.status] || 0) + 1; return m; }, {});
    return { ts: now, total: fleet.length, counts, fleet, island: def.id };
  }

  async function pollAlerts() {
    try {
      const res = await fetchBinary(def.api.alerts);
      if (res.status !== 200 || !res.body.length) return;
      const feed = parseFeedMessage(res.body);
      state.alerts = feed.filter(e => e.tripUpdate || e.vehicle).map(e => ({
        id: e.id,
        alert: e.alert || null,
      }));
    } catch (e) { state.lastError = e.message; }
  }

  return {
    def,
    state,
    loadRoutes,
    loadShapes,
    poll,
    getFleet,
    pollAlerts,
    getRoutes: () => state.routes,
    getShapes: () => state.shapes,
    getVehicles: () => state.latestVehicles,
    getStats: () => state.lastPollStats,
    getApiInfo: () => ({
      island: def.id,
      host: def.host,
      agency: def.agency,
      endpoints: def.api,
      routes: state.routes.length,
      shapes: state.shapes.length,
      vehicles: state.latestVehicles.length,
      lastPollTs: state.lastPollStats.ts,
      lastError: state.lastError,
      gtfs: def.api.gtfs,
      gtfsRt: { vp: def.api.vp, tu: def.api.tu, alerts: def.api.alerts },
      rtpi: def.api.rtpi,
    }),
  };
}

const BIG_ISLAND_DEF = {
  id: 'big-island',
  name: 'Hawaiʻi Island',
  short: 'Big Island',
  emoji: '🌋',
  host: 'myheleonbus.org',
  agency: 'Hele-On Bus',
  url: 'https://www.myheleonbus.org/',
  bbox: { minLat: 18.8, maxLat: 20.4, minLon: -156.2, maxLon: -154.7 },
  mapCenter: [-155.0608, 19.7063],
  mapZoom: 10,
  primary: true,
  api: {
    rtpi: '/api/rtpi?path=',
    gtfs: '/gtfs',
    vp: '/gtfs-rt/vehiclepositions',
    tu: '/gtfs-rt/tripupdates',
    alerts: '/gtfs-rt/alerts',
  },
};

function createIslandManager() {
  const pollers = {};
  for (const id of Object.keys(ISLAND_DEFS)) {
    pollers[id] = createIslandPoller(ISLAND_DEFS[id]);
  }

  function listIslands() {
    return [
      BIG_ISLAND_DEF,
      ...Object.values(ISLAND_DEFS).map(d => ({
        id: d.id,
        name: d.name,
        short: d.short,
        emoji: d.emoji,
        host: d.host,
        agency: d.agency,
        url: d.url,
        bbox: d.bbox,
        mapCenter: d.mapCenter,
        mapZoom: d.mapZoom,
        api: d.api,
      })),
    ];
  }

  function getPoller(islandId) {
    return pollers[islandId] || null;
  }

  async function pollAll() {
    await Promise.all(Object.values(pollers).map(p => p.poll().catch(() => [])));
  }

  async function boot() {
    await Promise.all(Object.values(pollers).map(async p => {
      await p.loadRoutes();
      await p.loadShapes();
    }));
    await pollAll();
    console.log('[islands] Kauaʻi + Maui transit booted');
    for (const p of Object.values(pollers)) {
      console.log(`  [${p.def.id}] ${p.state.routes.length} routes, ${p.state.shapes.length} shapes, ${p.state.latestVehicles.length} vehicles`);
    }
  }

  return { pollers, listIslands, getPoller, pollAll, boot, BIG_ISLAND_DEF, ISLAND_DEFS };
}

module.exports = { createIslandManager, createIslandPoller, ISLAND_DEFS, BIG_ISLAND_DEF };
