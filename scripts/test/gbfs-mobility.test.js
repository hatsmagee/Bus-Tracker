'use strict';
const assert = require('assert');
const { gbfsVehicleCount, gbfsDockCount, parseGbfsStations } = require('../lib/gbfs-mobility');

module.exports = {
  'prefers num_vehicles_available (GBFS v3)': () => {
    assert.strictEqual(gbfsVehicleCount({ num_vehicles_available: 6, num_bikes_available: 0 }), 6);
  },
  'sums vehicle_types_available when vehicles field missing': () => {
    assert.strictEqual(gbfsVehicleCount({
      vehicle_types_available: [{ vehicle_type_id: 'ICONIC', count: 4 }, { count: 2 }],
    }), 6);
  },
  'falls back to num_bikes_available for legacy feeds': () => {
    assert.strictEqual(gbfsVehicleCount({ num_bikes_available: 3 }), 3);
  },
  'parseGbfsStations joins info + status by string station_id': () => {
    const info = { data: { stations: [{ station_id: '3', name: 'Dock', lat: 19.5, lon: -156, capacity: 10 }] } };
    const status = { data: { stations: [{ station_id: '3', num_vehicles_available: 9, num_docks_available: 8 }] } };
    const out = parseGbfsStations(info, status);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].bikes, 9);
    assert.strictEqual(out[0].docks, 8);
  },
  'gbfsDockCount reads open docks': () => {
    assert.strictEqual(gbfsDockCount({ num_docks_available: 5 }), 5);
  },
};
