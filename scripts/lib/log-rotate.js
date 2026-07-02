'use strict';
// Tiny dependency-free log rotation + disk hygiene helpers. Keeps any on-disk
// log bounded (size-capped, N generations) so an ephemeral/light host (e.g.
// Render free tier) can never fill its disk from logs. Also sweeps stale temp
// files. All operations are best-effort and never throw.
const fs = require('fs');
const path = require('path');

const DEFAULTS = { maxBytes: 256 * 1024, maxFiles: 3 };

function rotate(filePath, maxFiles) {
  const oldest = `${filePath}.${maxFiles}`;
  try { if (fs.existsSync(oldest)) fs.unlinkSync(oldest); } catch {}
  for (let i = maxFiles - 1; i >= 1; i--) {
    const src = `${filePath}.${i}`;
    const dst = `${filePath}.${i + 1}`;
    try { if (fs.existsSync(src)) fs.renameSync(src, dst); } catch {}
  }
  try { if (fs.existsSync(filePath)) fs.renameSync(filePath, `${filePath}.1`); } catch {}
}

// Append a line, rotating the file first if it would exceed maxBytes.
function appendLine(filePath, line, opts = {}) {
  const { maxBytes, maxFiles } = { ...DEFAULTS, ...opts };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    let size = 0;
    try { size = fs.statSync(filePath).size; } catch {}
    if (size >= maxBytes) rotate(filePath, maxFiles);
    fs.appendFileSync(filePath, line.endsWith('\n') ? line : line + '\n');
  } catch {}
}

// Read the last `maxLines` lines of a (possibly large) file cheaply enough for
// our sizes (logs are size-capped, so this stays small).
function tail(filePath, maxLines = 500) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-maxLines);
  } catch { return []; }
}

// Delete files in `dir` matching any pattern whose mtime is older than maxAgeMs.
function cleanupStale(dir, { patterns = [], maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  let removed = 0;
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(dir)) {
      if (!patterns.some(re => re.test(f))) continue;
      const fp = path.join(dir, f);
      try {
        if (now - fs.statSync(fp).mtimeMs > maxAgeMs) { fs.unlinkSync(fp); removed++; }
      } catch {}
    }
  } catch {}
  return removed;
}

// Hard cap: if a file somehow exceeds maxBytes, truncate it to the last
// ~maxBytes bytes (keeps the tail, drops the head). Used as a belt-and-braces
// guard for any log we don't control the writer of.
function capFileSize(filePath, maxBytes = DEFAULTS.maxBytes) {
  try {
    const st = fs.statSync(filePath);
    if (st.size <= maxBytes) return;
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, st.size - maxBytes);
    fs.closeSync(fd);
    // Drop partial first line for cleanliness.
    const text = buf.toString('utf8');
    const nl = text.indexOf('\n');
    fs.writeFileSync(filePath, nl >= 0 ? text.slice(nl + 1) : text);
  } catch {}
}

module.exports = { appendLine, tail, cleanupStale, capFileSize, rotate, DEFAULTS };
