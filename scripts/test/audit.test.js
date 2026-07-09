'use strict';
const assert = require('assert');
const { isSufficient, isStale } = require('../audit-map-items');

const fresh = new Date().toISOString();
const old = new Date(Date.now() - 200 * 86400000).toISOString();

const full = {
  summary: 'A substantive summary of the place with enough context for visitors to understand what it is, why it matters on the island, and what to look for when visiting.',
  history: [
    { year: 1, text: 'a', source: 's' },
    { year: 2, text: 'b', source: 's' },
    { year: 3, text: 'c', source: 's' },
    { year: 4, text: 'd', source: 's' },
  ],
  photos: [{ url: 'u', credit: 'c' }, { url: 'u2', credit: 'c2' }],
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
    assert.strictEqual(isSufficient({ ...full, history: [full.history[0], full.history[1]] }), false);
  },
  'entry with no photos is insufficient'() {
    assert.strictEqual(isSufficient({ ...full, photos: [] }), false);
  },
  'skipped entries count as sufficient'() {
    assert.strictEqual(isSufficient({ status: 'skipped' }), true);
  },
};
