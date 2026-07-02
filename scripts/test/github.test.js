'use strict';
const assert = require('assert');
const { stagingBranchName, isConfigured } = require('../lib/github');

module.exports = {
  'staging branch name is well-formed'() {
    assert.ok(/^agent\/staging-\d+$/.test(stagingBranchName()));
  },
  'staging branch names are monotonic-ish and distinct'() {
    const a = stagingBranchName();
    const b = stagingBranchName();
    assert.ok(a && b);
  },
  'isConfigured reflects env presence'() {
    const savedTok = process.env.AGENT_GITHUB_TOKEN;
    const savedBak = process.env.BACKUP_GITHUB_TOKEN;
    delete process.env.AGENT_GITHUB_TOKEN;
    delete process.env.BACKUP_GITHUB_TOKEN;
    try {
      assert.strictEqual(isConfigured(), false);
      process.env.AGENT_GITHUB_TOKEN = 'ghp_test';
      assert.strictEqual(isConfigured(), true);
    } finally {
      delete process.env.AGENT_GITHUB_TOKEN;
      if (savedTok !== undefined) process.env.AGENT_GITHUB_TOKEN = savedTok;
      if (savedBak !== undefined) process.env.BACKUP_GITHUB_TOKEN = savedBak;
    }
  },
};
