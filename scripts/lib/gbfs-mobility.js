'use strict';

// GBFS v3 (PBSC / HIBIKE / Biki) reports live dock counts on num_vehicles_available.
// num_bikes_available was removed — reading it alone yields 0 everywhere.
function gbfsVehicleCount(stStat) {
  if (!stStat || typeof stStat !== 'object') return 0;
  const fromTypes = Array.isArray(stStat.vehicle_types_available)
    ? stStat.vehicle_types_available.reduce((n, vt) => n + (Number(vt.count) || 0), 0)
    : null;
  if (stStat.num_vehicles_available != null && stStat.num_vehicles_available !== '') {
    const n = Number(stStat.num_vehicles_available);
    if (Number.isFinite(n)) return Math.max(0, n);
  }
  if (fromTypes != null) return fromTypes;
  if (stStat.num_bikes_available != null && stStat.num_bikes_available !== '') {
    const n = Number(stStat.num_bikes_available);
    if (Number.isFinite(n)) return Math.max(0, n);
  }
  return 0;
}

function gbfsDockCount(stStat) {
  if (!stStat || typeof stStat !== 'object') return 0;
  if (stStat.num_docks_available != null && stStat.num_docks_available !== '') {
    const n = Number(stStat.num_docks_available);
    if (Number.isFinite(n)) return Math.max(0, n);
  }
  return 0;
}

function gbfsText(field) {
  if (!field) return '';
  if (typeof field === 'string') return field;
  if (Array.isArray(field)) {
    const en = field.find(x => x.language === 'en');
    return (en && en.text) || (field[0] && field[0].text) || '';
  }
  return '';
}

function indexGbfsStatus(stations) {
  const byId = new Map();
  for (const s of stations || []) {
    byId.set(String(s.station_id), s);
    if (s.station_id != null) byId.set(s.station_id, s);
  }
  return byId;
}

function parseGbfsStations(info, status) {
  const statusById = indexGbfsStatus(status.data && status.data.stations);
  return (info.data.stations || []).map(st => {
    const stStat = statusById.get(st.station_id) || statusById.get(String(st.station_id)) || {};
    return {
      id: st.station_id,
      name: gbfsText(st.name) || gbfsText(st.short_name) || `Station ${st.station_id}`,
      lat: st.lat,
      lon: st.lon,
      address: st.address || '',
      capacity: st.capacity,
      bikes: gbfsVehicleCount(stStat),
      docks: gbfsDockCount(stStat),
      isRenting: stStat.is_renting !== false,
    };
  });
}

module.exports = {
  gbfsVehicleCount,
  gbfsDockCount,
  gbfsText,
  indexGbfsStatus,
  parseGbfsStations,
};
