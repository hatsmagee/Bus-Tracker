'use strict';

const fs = require('fs');
const { AGENT_STATE_PATH, AGENT_QUEUE_PATH, ensureAgentTmp } = require('./paths');
const { readJsonFile, writeJsonFile } = require('./map-items-schema');

const FAILURE_WINDOW_MS = 60 * 60 * 1000;
const FAILURE_LIMIT = 3;

function defaultState() {
  return {
    circuitOpen: false,
    circuitOpenedAt: null,
    failures: [],
    lastResearchAt: null,
    lastPublishAt: null,
    lastPublishSha: null,
    lastPrNumber: null,
    enrichedToday: 0,
    enrichedDay: null,
    lastError: null,
    lastTopic: null,
  };
}

function loadState() {
  ensureAgentTmp();
  return readJsonFile(AGENT_STATE_PATH, defaultState());
}

function saveState(state) {
  ensureAgentTmp();
  writeJsonFile(AGENT_STATE_PATH, state);
}

function recordFailure(state, error) {
  const now = Date.now();
  state.failures = (state.failures || []).filter(ts => now - ts < FAILURE_WINDOW_MS);
  state.failures.push(now);
  state.lastError = String(error);
  if (state.failures.length >= FAILURE_LIMIT) {
    state.circuitOpen = true;
    state.circuitOpenedAt = new Date().toISOString();
    console.error(`[agent] circuit breaker OPEN (${FAILURE_LIMIT} failures in 1h)`);
  }
  saveState(state);
  return state;
}

function resetCircuit(state) {
  state.circuitOpen = false;
  state.circuitOpenedAt = null;
  state.failures = [];
  state.lastError = null;
  saveState(state);
  return state;
}

function circuitOk(state) {
  if (!state.circuitOpen) return true;
  return false;
}

function bumpEnriched(state) {
  const day = new Date().toISOString().slice(0, 10);
  if (state.enrichedDay !== day) {
    state.enrichedDay = day;
    state.enrichedToday = 0;
  }
  state.enrichedToday += 1;
  saveState(state);
}

function loadQueue() {
  ensureAgentTmp();
  return readJsonFile(AGENT_QUEUE_PATH, { items: [], updatedAt: null });
}

function saveQueue(queue) {
  ensureAgentTmp();
  writeJsonFile(AGENT_QUEUE_PATH, queue);
}

module.exports = {
  loadState,
  saveState,
  recordFailure,
  resetCircuit,
  circuitOk,
  bumpEnriched,
  loadQueue,
  saveQueue,
  defaultState,
};
