'use strict';
const assert = require('assert');
const { parseOahuTs, parseVehicleXml, resolveAppId, ATTRIBUTION } = require('../lib/thebus');

module.exports = {
  'parseOahuTs reads HST wall-clock timestamps': () => {
    const ms = parseOahuTs('12/27/2022 2:25:11 PM');
    assert.ok(ms);
    const d = new Date(ms);
    // 14:25 HST = 00:25 UTC next day
    assert.strictEqual(d.getUTCHours(), 0);
    assert.strictEqual(d.getUTCMinutes(), 25);
  },
  'parseVehicleXml extracts fleet fields': () => {
    const xml = `<?xml version="1.0"?>
<vehicles>
<timestamp>12/27/2022 2:25:13 PM</timestamp>
<vehicle>
<number>3501</number>
<trip>4424647</trip>
<driver>7645</driver>
<latitude>21.33265</latitude>
<longitude>-157.95094</longitude>
<adherence>-5</adherence>
<last_message>12/27/2022 2:25:11 PM</last_message>
<route_short_name>303</route_short_name>
<headsign>AIRPORT - HICKAM</headsign>
</vehicle>
</vehicles>`;
    const parsed = parseVehicleXml(xml);
    assert.strictEqual(parsed.vehicles.length, 1);
    assert.strictEqual(parsed.vehicles[0].number, '3501');
    assert.strictEqual(parsed.vehicles[0].route_short_name, '303');
    assert.strictEqual(parsed.vehicles[0].adherence, '-5');
  },
  'parseVehicleXml surfaces API key errors': () => {
    const parsed = parseVehicleXml(`<vehicles><errorMessage>Invalid or unspecified API key</errorMessage></vehicles>`);
    assert.ok(parsed.error);
    assert.strictEqual(parsed.vehicles.length, 0);
  },
  'attribution legend is the OTS required text': () => {
    assert.ok(/Oahu Transit Services/i.test(ATTRIBUTION));
  },
  'resolveAppId reads THEBUS_APP_ID': () => {
    const prev = process.env.THEBUS_APP_ID;
    process.env.THEBUS_APP_ID = 'test-key-xyz';
    assert.strictEqual(resolveAppId(), 'test-key-xyz');
    if (prev == null) delete process.env.THEBUS_APP_ID;
    else process.env.THEBUS_APP_ID = prev;
  },
};
