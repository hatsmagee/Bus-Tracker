'use strict';
const assert = require('assert');
const { isSufficient, isStale } = require('../audit-map-items');

const fresh = new Date().toISOString();
const old = new Date(Date.now() - 200 * 86400000).toISOString();

const full = {
  summary: 'x',
  history: [{ year: 1, text: 'a', source: 's' }, { year: 2, text: 'b', source: 's' }],
  photos: [{ url: 'u', credit: 'c' }],
  provenance: { generatedAt: fresh },
};

module.exports = {
  'entry with no provenance is stale'() {
    assert.strictEqual(isStale({}), true);
  },
  'recent entry is not stale'() {
    assert.strictEqual(isStale({ provenance: { generatedAt: fresh } }), false);
  },
  'old entry is stale'() {
    assert.strictEqual(isStale({ provenance: { generatedAt: old } }), true);
  },
  'complete fresh entry is sufficient'() {
    assert.strictEqual(isSufficient(full), true);
  },
  'entry with one history item is insufficient'() {
    assert.strictEqual(isSufficient({ ...full, history: [full.history[0]] }), false);
  },
  'entry with no photos is insufficient'() {
    assert.strictEqual(isSufficient({ ...full, photos: [] }), false);
  },
  'skipped entries count as sufficient'() {
    assert.strictEqual(isSufficient({ status: 'skipped' }), true);
  },
};
