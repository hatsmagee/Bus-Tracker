#!/usr/bin/env node
'use strict';
// Tiny dependency-free test runner. Each *.test.js exports an object of
// name -> function; a throw fails the test. Exits non-zero on any failure so it
// can gate the agent's publish step (see scripts/publish-map-items.js).
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.js'));

let pass = 0, fail = 0;
const failures = [];

for (const f of files) {
  const suite = require(path.join(dir, f));
  for (const [name, fn] of Object.entries(suite)) {
    try {
      const r = fn();
      if (r && typeof r.then === 'function') {
        throw new Error('async tests not supported in this runner');
      }
      pass++;
      console.log(`  ok   ${f} › ${name}`);
    } catch (e) {
      fail++;
      failures.push(`${f} › ${name}: ${e.message}`);
      console.log(`  FAIL ${f} › ${name}: ${e.message}`);
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.error('\nFailures:\n' + failures.map(x => '  - ' + x).join('\n'));
  process.exit(1);
}
process.exit(0);
