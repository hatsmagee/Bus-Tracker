'use strict';
const assert = require('assert');
const { validateEntry, validateMapItemsDoc } = require('../lib/map-items-schema');

const goodEntry = {
  title: 'W. M. Keck Observatory',
  summary: 'Twin 10 m telescopes on Maunakea.',
  history: [
    { year: 1992, text: 'Keck I first light.', source: 'https://example.org' },
    { year: 1996, text: 'Keck II first light.', source: 'https://example.org' },
  ],
  photos: [{ url: 'https://example.org/keck.jpg', credit: 'NASA — PD', caption: 'Keck domes' }],
  links: [{ label: 'Site', url: 'https://keckobservatory.org' }],
  provenance: { sources: ['https://example.org'], model: 'x', generatedAt: new Date().toISOString(), reviewed: false },
  status: 'ok',
};

module.exports = {
  'valid entry passes'() {
    assert.deepStrictEqual(validateEntry('summit:keck', goodEntry), []);
  },
  'missing title fails'() {
    const e = { ...goodEntry }; delete e.title;
    assert.ok(validateEntry('summit:keck', e).some(x => /title/.test(x)));
  },
  'history entry without year fails'() {
    const e = { ...goodEntry, history: [{ text: 'no year', source: 'x' }] };
    assert.ok(validateEntry('k', e).some(x => /history/.test(x)));
  },
  'photo without credit fails'() {
    const e = { ...goodEntry, photos: [{ url: 'https://x/y.jpg' }] };
    assert.ok(validateEntry('k', e).some(x => /credit/.test(x)));
  },
  'doc with items validates'() {
    assert.deepStrictEqual(validateMapItemsDoc({ items: { 'summit:keck': goodEntry } }), []);
  },
  'doc missing items fails'() {
    assert.ok(validateMapItemsDoc({}).length > 0);
  },
};
