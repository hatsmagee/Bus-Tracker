'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');
const TMP_AGENT = process.env.AGENT_TMP_DIR || (process.env.RENDER ? '/tmp/agent' : path.join(ROOT, '.agent-tmp'));

const MAP_ITEMS_PATH = path.join(DATA_DIR, 'map-items.json');
const MAP_ITEMS_STAGED_PATH = path.join(DATA_DIR, 'map-items.staged.json');
const AGENT_STATE_PATH = path.join(TMP_AGENT, 'agent-state.json');
const AGENT_QUEUE_PATH = path.join(TMP_AGENT, 'agent-queue.json');
const REFERENCE_PATH = path.join(DATA_DIR, 'heleon-reference.json');

function ensureAgentTmp() {
  fs.mkdirSync(TMP_AGENT, { recursive: true });
}

module.exports = {
  ROOT,
  DATA_DIR,
  TMP_AGENT,
  MAP_ITEMS_PATH,
  MAP_ITEMS_STAGED_PATH,
  AGENT_STATE_PATH,
  AGENT_QUEUE_PATH,
  REFERENCE_PATH,
  ensureAgentTmp,
};
