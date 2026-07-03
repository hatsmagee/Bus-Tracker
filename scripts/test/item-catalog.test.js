'use strict';
const assert = require('assert');
const { staticCatalog } = require('../lib/item-catalog');

module.exports = {
  'catalog is non-empty'() {
    assert.ok(staticCatalog().length >= 100, 'expected a large statewide item universe');
  },
  'every item has category:id key and title'() {
    for (const it of staticCatalog()) {
      assert.ok(/^[a-z]+:.+/.test(it.key), `bad key: ${it.key}`);
      assert.ok(it.title && typeof it.title === 'string', `missing title for ${it.key}`);
    }
  },
  'keys are unique'() {
    const keys = staticCatalog().map(i => i.key);
    assert.strictEqual(new Set(keys).size, keys.length, 'duplicate keys present');
  },
};
