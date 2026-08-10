'use strict';
// The server runs for weeks on a free-tier instance. Several caches are keyed by
// values that ultimately come from a request or an external stream (USGS gauge
// site, aircraft tail, vessel MMSI, APRS callsign), and none of them had any
// eviction — they only ever grew. Two of them (vessels, APRS) filtered stale
// entries on the way OUT while keeping every key ever seen resident.
//
// These tests pin the eviction helper and the input validation that stops a
// crawler from interning unbounded keys in the first place.
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../lib/paths');

const SERVER = fs.readFileSync(path.join(ROOT, 'heleon-server.js'), 'utf8');

function loadCacheSet() {
  const i = SERVER.indexOf('function cacheSet(');
  if (i < 0) throw new Error('cacheSet() not found in heleon-server.js — did it move or get renamed?');
  const end = SERVER.indexOf('\n}', i);
  if (end < 0) throw new Error('cacheSet() body not parseable');
  return new Function(SERVER.slice(i, end + 2) + '; return cacheSet;')();
}

const cacheSet = loadCacheSet();

module.exports = {
  'cacheSet evicts oldest entries past the cap': () => {
    const m = new Map();
    for (let k = 0; k < 250; k++) cacheSet(m, 'k' + k, k, 200);
    if (m.size !== 200) throw new Error(`expected size 200, got ${m.size}`);
    if (m.has('k0')) throw new Error('oldest entry was not evicted');
    if (!m.has('k249')) throw new Error('newest entry was evicted');
  },

  'cacheSet updating an existing key neither grows nor evicts': () => {
    const m = new Map();
    for (let k = 0; k < 200; k++) cacheSet(m, 'k' + k, k, 200);
    const before = m.size;
    cacheSet(m, 'k199', 'updated', 200);
    if (m.size !== before) throw new Error(`size changed from ${before} to ${m.size}`);
    if (m.get('k199') !== 'updated') throw new Error('value not updated');
  },

  'cacheSet handles a cap of 1 and stays exact': () => {
    const m = new Map();
    for (let k = 0; k < 10; k++) cacheSet(m, 'k' + k, k, 1);
    if (m.size !== 1) throw new Error(`expected size 1, got ${m.size}`);
    if (!m.has('k9')) throw new Error('did not keep the newest entry');
  },

  'request-keyed caches all go through cacheSet': () => {
    // A bare .set() on one of these is how the leak comes back.
    const guarded = ['gaugeStatsCache', 'gaugeHistCache', 'aircraftPhotoCache', 'vesselInfoCache'];
    const offenders = [];
    SERVER.split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      for (const name of guarded) {
        if (new RegExp(`\\b${name}\\.set\\(`).test(line)) offenders.push(`${i + 1}: ${line.trim()}`);
      }
    });
    if (offenders.length) {
      throw new Error('these caches must use cacheSet(map, key, value, max):\n  ' + offenders.join('\n  '));
    }
  },

  'stream-keyed caches delete stale entries rather than only filtering': () => {
    // vesselCache and aprsCache are fed by long-lived external streams; the
    // serve path must evict, not just skip.
    if (!/vesselCache\.delete\(/.test(SERVER)) {
      throw new Error('vesselCache never deletes — stale vessels stay resident forever');
    }
    if (!/aprsCache\.delete\(/.test(SERVER)) {
      throw new Error('aprsCache never deletes — every callsign ever heard stays resident');
    }
  },

  'gauge-history validates site and param before using them': () => {
    // They are interpolated into an upstream USGS URL and used as a cache key.
    const i = SERVER.indexOf("p === '/api/gauge-history'");
    if (i < 0) throw new Error('/api/gauge-history handler not found');
    const block = SERVER.slice(i, i + 1200);
    if (!/test\(site\)/.test(block)) {
      throw new Error('site is not validated with a regex before use');
    }
    if (!/test\(param\)/.test(block)) {
      throw new Error('param is not validated with a regex before use');
    }
  },

  'the API error handler cannot throw after headers are sent': () => {
    // The old handler called res.writeHead(500) unconditionally. When a handler
    // threw mid-response that raised ERR_HTTP_HEADERS_SENT inside the catch and
    // the request hung forever (verified).
    const i = SERVER.indexOf('handleApi(url, res, req).catch(');
    if (i < 0) throw new Error('handleApi catch block not found');
    const block = SERVER.slice(i, i + 900);
    if (!/res\.headersSent/.test(block)) {
      throw new Error('catch block does not check res.headersSent before writeHead');
    }
  },
};
