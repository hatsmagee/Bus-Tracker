'use strict';
const assert = require('assert');
const { checkNoKeysGuard } = require('../lib/no-keys-guard');

module.exports = {
  'passes with no paid keys'() {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      assert.strictEqual(checkNoKeysGuard().ok, true);
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  },
  'refuses when OPENAI_API_KEY present'() {
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test';
    try {
      const r = checkNoKeysGuard();
      assert.strictEqual(r.ok, false);
      assert.ok(r.blocked.includes('OPENAI_API_KEY'));
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
    }
  },
  'refuses when TAVILY_API_KEY present'() {
    const saved = process.env.TAVILY_API_KEY;
    process.env.TAVILY_API_KEY = 'tvly-test';
    try {
      assert.strictEqual(checkNoKeysGuard().ok, false);
    } finally {
      if (saved === undefined) delete process.env.TAVILY_API_KEY;
      else process.env.TAVILY_API_KEY = saved;
    }
  },
};
