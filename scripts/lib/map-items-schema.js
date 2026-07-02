'use strict';

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function validateEntry(key, entry) {
  const errs = [];
  if (!isObj(entry)) return [`${key}: not an object`];
  if (!entry.title || typeof entry.title !== 'string') errs.push(`${key}: missing title`);
  if (!entry.summary || typeof entry.summary !== 'string') errs.push(`${key}: missing summary`);
  if (!Array.isArray(entry.history)) errs.push(`${key}: history must be array`);
  else {
    for (const [i, h] of entry.history.entries()) {
      if (!h || typeof h.year !== 'number' || !h.text || !h.source) {
        errs.push(`${key}: history[${i}] needs year, text, source`);
      }
    }
  }
  if (!Array.isArray(entry.photos)) errs.push(`${key}: photos must be array`);
  else {
    for (const [i, p] of entry.photos.entries()) {
      if (!p || !p.url || !p.credit) errs.push(`${key}: photos[${i}] needs url and credit`);
    }
  }
  if (entry.links && !Array.isArray(entry.links)) errs.push(`${key}: links must be array`);
  if (entry.provenance && !isObj(entry.provenance)) errs.push(`${key}: provenance must be object`);
  return errs;
}

function validateMapItemsDoc(doc) {
  const errs = [];
  if (!isObj(doc)) return ['root: not an object'];
  if (!isObj(doc.items)) return ['items: missing or not object'];
  for (const [key, entry] of Object.entries(doc.items)) {
    errs.push(...validateEntry(key, entry));
  }
  return errs;
}

function emptyDoc() {
  return {
    _comment: 'Staged map-item candidates — not live until smoke-tested PR merge.',
    source: 'agent',
    updatedAt: new Date().toISOString(),
    items: {},
  };
}

function readJsonFile(filePath, fallback) {
  const fs = require('fs');
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, doc) {
  const fs = require('fs');
  const path = require('path');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  doc.updatedAt = new Date().toISOString();
  fs.writeFileSync(filePath, JSON.stringify(doc, null, 2) + '\n');
}

module.exports = {
  validateEntry,
  validateMapItemsDoc,
  emptyDoc,
  readJsonFile,
  writeJsonFile,
};
