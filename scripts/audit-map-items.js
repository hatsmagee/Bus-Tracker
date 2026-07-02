'use strict';

const { staticCatalog } = require('./lib/item-catalog');
const { MAP_ITEMS_PATH } = require('./lib/paths');
const { readJsonFile } = require('./lib/map-items-schema');
const { saveQueue } = require('./lib/agent-state');

const STALE_DAYS = parseInt(process.env.AGENT_STALE_DAYS || '90', 10);

function isStale(entry) {
  const ts = entry && entry.provenance && entry.provenance.generatedAt;
  if (!ts) return true;
  const age = Date.now() - new Date(ts).getTime();
  return age > STALE_DAYS * 86400000;
}

function isSufficient(entry) {
  if (!entry || entry.status === 'skipped') return true;
  if (!entry.summary || !Array.isArray(entry.history) || entry.history.length < 2) return false;
  if (!Array.isArray(entry.photos) || !entry.photos.length) return false;
  return !isStale(entry);
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
  };

  const queue = [];

  for (const item of catalog) {
    const existing = liveItems[item.key];
    if (!existing) {
      report.missing.push(item.key);
      queue.push({ ...item, reason: 'missing' });
    } else if (isStale(existing)) {
      report.stale.push(item.key);
      queue.push({ ...item, reason: 'stale' });
    } else if (!isSufficient(existing)) {
      report.needsResearch.push(item.key);
      queue.push({ ...item, reason: 'insufficient' });
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
