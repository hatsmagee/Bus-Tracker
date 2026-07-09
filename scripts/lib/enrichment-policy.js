'use strict';

const POLICY_PATH = require('path').join(__dirname, '..', 'agent', 'ENRICHMENT_POLICY.md');

const MIN_SUMMARY = 40;
const COMPLETE_SUMMARY = 120;
const MIN_HISTORY = 2;
const COMPLETE_HISTORY = 4;
const MIN_PHOTOS = 1;
const COMPLETE_PHOTOS = 2;

function slugify(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[\u02BB\u2018\u2019'`ʻʼ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function catalogKey(prefix, nameOrId) {
  return `${prefix}:${slugify(nameOrId)}`;
}

function heritageKey(name) { return catalogKey('heritage', name); }
function assetKey(id) { return catalogKey('asset', id); }
function mobilityKey(systemId) { return catalogKey('mobility', systemId); }

function blockingGaps(entry) {
  const gaps = [];
  if (!entry) return ['missing'];
  if (entry.status === 'skipped') return [];
  if (!entry.summary || entry.summary.length < MIN_SUMMARY) gaps.push('thin-summary');
  if (!Array.isArray(entry.history) || entry.history.length < MIN_HISTORY) gaps.push('thin-history');
  if (!Array.isArray(entry.photos) || entry.photos.length < MIN_PHOTOS) gaps.push('no-photos');
  return gaps;
}

function qualityGaps(entry) {
  const gaps = [];
  if (!entry || entry.status === 'skipped') return gaps;
  if (!entry.summary || entry.summary.length < COMPLETE_SUMMARY) gaps.push('short-summary');
  if (!Array.isArray(entry.history) || entry.history.length < COMPLETE_HISTORY) gaps.push('more-history');
  if (!Array.isArray(entry.photos) || entry.photos.length < COMPLETE_PHOTOS) gaps.push('more-photos');
  return gaps;
}

function entryGaps(entry) {
  return [...blockingGaps(entry), ...qualityGaps(entry)];
}

function enrichmentMeta(entry) {
  if (!entry) return { status: 'missing', gaps: ['missing'], pass: 0, level: 0 };
  if (entry.status === 'skipped') return { status: 'skipped', gaps: [], pass: 0, level: 100 };
  const block = blockingGaps(entry);
  const qual = qualityGaps(entry);
  const pass = (entry.enrichment && entry.enrichment.pass)
    || (entry.provenance && entry.provenance.researchPass)
    || 0;
  if (block.length) return { status: 'incomplete', gaps: block, pass, level: 0 };
  if (qual.length || (entry.enrichment && entry.enrichment.status === 'partial')) {
    return { status: 'partial', gaps: qual, pass, level: Math.round(40 + (COMPLETE_HISTORY - qual.length) * 15) };
  }
  return { status: 'complete', gaps: [], pass, level: 100 };
}

function isPublishable(entry) {
  return blockingGaps(entry).length === 0;
}

function isComplete(entry) {
  const meta = enrichmentMeta(entry);
  return meta.status === 'complete';
}

function isEnriched(entry) {
  return isComplete(entry);
}

function enrichmentPriority(item, existing) {
  let score = 0;
  const meta = enrichmentMeta(existing);
  if (!existing) score += 100;
  else if (meta.status === 'incomplete') score += 90;
  else if (meta.status === 'partial') score += 80;
  else {
    const gaps = entryGaps(existing);
    if (gaps.includes('no-photos')) score += 60;
    if (gaps.includes('thin-history')) score += 40;
    if (gaps.includes('thin-summary')) score += 20;
  }
  if (item.reason === 'missing') score += 30;
  else if (item.reason === 'partial') score += 28;
  else if (item.reason === 'insufficient') score += 25;
  else if (item.reason === 'stale') score += 10;
  const cat = String(item.key || '').split(':')[0];
  if (cat === 'heritage' || ['maui', 'oahu', 'kauai', 'molokai', 'lanai'].includes(cat)) score += 15;
  if (cat === 'category') score -= 20;
  return score;
}

function mergeEnrichmentEntries(existing, next) {
  if (!existing) return next;
  const histYears = new Set((existing.history || []).map(h => h.year));
  const history = [...(existing.history || [])];
  for (const h of (next.history || [])) {
    if (!histYears.has(h.year)) { history.push(h); histYears.add(h.year); }
  }
  history.sort((a, b) => a.year - b.year);

  const photoUrls = new Set((existing.photos || []).map(p => p.url));
  const photos = [...(existing.photos || [])];
  for (const p of (next.photos || [])) {
    if (p.url && !photoUrls.has(p.url)) { photos.push(p); photoUrls.add(p.url); }
  }

  const linkUrls = new Set((existing.links || []).map(l => l.url));
  const links = [...(existing.links || [])];
  for (const l of (next.links || [])) {
    if (l.url && !linkUrls.has(l.url)) { links.push(l); linkUrls.add(l.url); }
  }

  const summary = (next.summary && next.summary.length > (existing.summary || '').length)
    ? next.summary : (existing.summary || next.summary);

  const pass = Math.max(
    (existing.enrichment && existing.enrichment.pass) || 0,
    (existing.provenance && existing.provenance.researchPass) || 0,
    (next.enrichment && next.enrichment.pass) || 0,
    (next.provenance && next.provenance.researchPass) || 0,
  ) + 1;

  const merged = {
    ...existing,
    ...next,
    title: next.title || existing.title,
    summary,
    history,
    photos: photos.slice(0, 5),
    links: links.slice(0, 6),
    provenance: {
      ...(existing.provenance || {}),
      ...(next.provenance || {}),
      sources: [...new Set([...(existing.provenance && existing.provenance.sources) || [], ...(next.provenance && next.provenance.sources) || []])],
      researchPass: pass,
      lastDeepenedAt: new Date().toISOString(),
      generatedAt: (existing.provenance && existing.provenance.generatedAt) || (next.provenance && next.provenance.generatedAt),
    },
  };
  const meta = enrichmentMeta(merged);
  merged.enrichment = {
    status: meta.status === 'complete' ? 'complete' : 'partial',
    gaps: meta.gaps,
    pass,
    level: meta.level,
    updatedAt: new Date().toISOString(),
  };
  if (meta.status === 'complete') merged.status = 'ok';
  else merged.status = 'partial';
  return merged;
}

function readPolicyText() {
  const fs = require('fs');
  try { return fs.readFileSync(POLICY_PATH, 'utf8'); }
  catch { return ''; }
}

module.exports = {
  POLICY_PATH,
  MIN_SUMMARY,
  COMPLETE_SUMMARY,
  MIN_HISTORY,
  COMPLETE_HISTORY,
  MIN_PHOTOS,
  COMPLETE_PHOTOS,
  slugify,
  catalogKey,
  heritageKey,
  assetKey,
  mobilityKey,
  blockingGaps,
  qualityGaps,
  entryGaps,
  enrichmentMeta,
  isPublishable,
  isComplete,
  isEnriched,
  enrichmentPriority,
  mergeEnrichmentEntries,
  readPolicyText,
};
