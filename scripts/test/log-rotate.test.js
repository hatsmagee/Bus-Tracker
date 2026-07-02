'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { appendLine, tail, capFileSize } = require('../lib/log-rotate');

function tmpFile() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lrtest-'));
  return { dir: d, file: path.join(d, 'agent.log') };
}

module.exports = {
  'append stays bounded to maxFiles generations'() {
    const { dir, file } = tmpFile();
    try {
      for (let i = 0; i < 2000; i++) appendLine(file, 'x'.repeat(200), { maxBytes: 8192, maxFiles: 3 });
      const gens = fs.readdirSync(dir).filter(f => f.startsWith('agent.log'));
      assert.ok(gens.length <= 4, `expected <=4 generations, got ${gens.length}`);
      const total = gens.reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0);
      assert.ok(total < 8192 * 5, `total ${total} not bounded`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  },
  'tail returns last N lines'() {
    const { dir, file } = tmpFile();
    try {
      for (let i = 0; i < 50; i++) appendLine(file, 'line' + i, { maxBytes: 1e7, maxFiles: 3 });
      const t = tail(file, 3);
      assert.deepStrictEqual(t, ['line47', 'line48', 'line49']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  },
  'capFileSize truncates oversized files'() {
    const { dir, file } = tmpFile();
    try {
      fs.writeFileSync(file, Array.from({ length: 1000 }, (_, i) => 'row' + i).join('\n') + '\n');
      const before = fs.statSync(file).size;
      capFileSize(file, 512);
      const after = fs.statSync(file).size;
      assert.ok(after <= 512, `after ${after} > 512`);
      assert.ok(after < before);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  },
};
