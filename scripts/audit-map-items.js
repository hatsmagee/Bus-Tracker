'use strict';

const { staticCatalog } = require('./lib/item-catalog');
const { MAP_ITEMS_PATH } = require('./lib/paths');
const { readJsonFile } = require('./lib/map-items-schema');
const { saveQueue } = require('./lib/agent-state');
const { entryGaps, enrichmentMeta, isComplete } = require('./lib/enrichment-policy');

const STALE_DAYS = parseInt(process.env.AGENT_STALE_DAYS || '90', 10);

function isStale(entry) {
  const ts = entry && entry.provenance && entry.provenance.generatedAt;
  if (!ts) return true;
  const age = Date.now() - new Date(ts).getTime();
  return age > STALE_DAYS * 86400000;
}

function isSufficient(entry) {
  if (!entry || entry.status === 'skipped') return true;
  if (isStale(entry)) return false;
  return isComplete(entry);
}

function audit() {
  const catalog = staticCatalog();
  const live = readJsonFile(MAP_ITEMS_PATH, { items: {} });
  const liveItems = live.items || {};

  const report = {
    auditedAt: new Date().toISOString(),
    totalCatalog: catalog.length,
    sufficient: [],
    needsResearch: [],
    stale: [],
    missing: [],
    noPhotos: [],
    thinHistory: [],
    partial: [],
  };

  const queue = [];

  for (const item of catalog) {
    const existing = liveItems[item.key];
    const meta = enrichmentMeta(existing);
    if (!existing) {
      report.missing.push(item.key);
      queue.push({ ...item, reason: 'missing', gaps: ['missing'] });
    } else if (isStale(existing)) {
      report.stale.push(item.key);
      queue.push({ ...item, reason: 'stale', gaps: entryGaps(existing), enrichment: meta });
    } else if (meta.status === 'partial') {
      report.partial.push(item.key);
      report.needsResearch.push(item.key);
      if (meta.gaps.includes('more-photos') || meta.gaps.includes('no-photos')) report.noPhotos.push(item.key);
      if (meta.gaps.includes('more-history') || meta.gaps.includes('thin-history')) report.thinHistory.push(item.key);
      queue.push({ ...item, reason: 'partial', gaps: meta.gaps, enrichment: meta });
    } else if (!isSufficient(existing)) {
      const gaps = entryGaps(existing);
      report.needsResearch.push(item.key);
      if (gaps.includes('no-photos')) report.noPhotos.push(item.key);
      if (gaps.includes('thin-history')) report.thinHistory.push(item.key);
      queue.push({ ...item, reason: 'insufficient', gaps, enrichment: meta });
    } else {
      report.sufficient.push(item.key);
    }
  }

  saveQueue({ items: queue, updatedAt: new Date().toISOString(), report });

  return { report, queue };
}

if (require.main === module) {
  const { report, queue } = audit();
  console.log(JSON.stringify({
    ...report,
    queueSize: queue.length,
    sufficientCount: report.sufficient.length,
  }, null, 2));
}

module.exports = { audit, isSufficient, isStale };
