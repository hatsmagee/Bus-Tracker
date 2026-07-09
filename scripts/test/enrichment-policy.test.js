'use strict';
const assert = require('assert');
const {
  heritageKey, entryGaps, enrichmentPriority, enrichmentMeta,
  isPublishable, isComplete, mergeEnrichmentEntries,
} = require('../lib/enrichment-policy');

const minEntry = {
  summary: 'A substantive summary of the place with enough context for visitors.',
  history: [
    { year: 1900, text: 'Event one from a real source sentence.', source: 'https://example.com/a' },
    { year: 1950, text: 'Event two from a real source sentence.', source: 'https://example.com/b' },
  ],
  photos: [{ url: 'https://example.com/p.jpg', credit: 'Test' }],
};

module.exports = {
  'heritage keys slugify unicode names': () => {
    assert.strictEqual(heritageKey('Puʻukoholā Heiau'), 'heritage:puukohola-heiau');
  },
  'entryGaps flags missing photos and history': () => {
    const gaps = entryGaps({ summary: 'x'.repeat(50), history: [{ year: 1900, text: 'a', source: 'u' }], photos: [] });
    assert.ok(gaps.includes('no-photos'));
    assert.ok(gaps.includes('thin-history'));
  },
  'isPublishable accepts minimum bar': () => {
    assert.strictEqual(isPublishable(minEntry), true);
    assert.strictEqual(isComplete(minEntry), false);
  },
  'isComplete requires depth': () => {
    const complete = {
      ...minEntry,
      summary: 'x'.repeat(120),
      history: [
        ...minEntry.history,
        { year: 2000, text: 'Third event.', source: 'https://example.com/c' },
        { year: 2010, text: 'Fourth event.', source: 'https://example.com/d' },
      ],
      photos: [
        ...minEntry.photos,
        { url: 'https://example.com/p2.jpg', credit: 'Test 2' },
      ],
    };
    assert.strictEqual(isComplete(complete), true);
    assert.strictEqual(enrichmentMeta(complete).status, 'complete');
  },
  'enrichmentMeta marks partial publishable items': () => {
    const meta = enrichmentMeta(minEntry);
    assert.strictEqual(meta.status, 'partial');
    assert.ok(meta.gaps.includes('short-summary'));
  },
  'mergeEnrichmentEntries combines history and photos': () => {
    const next = {
      ...minEntry,
      history: [{ year: 1800, text: 'Older event.', source: 'https://example.com/old' }],
      photos: [{ url: 'https://example.com/new.jpg', credit: 'New' }],
      provenance: { sources: ['https://example.com'], researchPass: 1 },
    };
    const merged = mergeEnrichmentEntries(minEntry, next);
    assert.strictEqual(merged.history.length, 3);
    assert.strictEqual(merged.photos.length, 2);
    assert.strictEqual(merged.enrichment.status, 'partial');
  },
  'enrichmentPriority prefers missing heritage items': () => {
    const item = { key: 'heritage:foo', reason: 'missing' };
    const score = enrichmentPriority(item, null);
    assert.ok(score > enrichmentPriority({ key: 'category:repeaters', reason: 'stale' }, { summary: 'ok', history: [{ year: 1, text: 'a', source: 'u' }, { year: 2, text: 'b', source: 'u' }], photos: [{ url: 'u', credit: 'c' }] }));
  },
  'enrichmentPriority boosts partial items': () => {
    const partial = { key: 'heritage:foo', reason: 'partial' };
    const stale = { key: 'heritage:bar', reason: 'stale' };
    const live = { ...minEntry, enrichment: { status: 'partial', gaps: ['more-history'] } };
    assert.ok(enrichmentPriority(partial, live) > enrichmentPriority(stale, live));
  },
};
