'use strict';

const BLOCKED_ENV_KEYS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'TAVILY_API_KEY',
  'BRAVE_API_KEY',
  'SERPER_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_SEARCH_API_KEY',
];

function checkNoKeysGuard() {
  const found = BLOCKED_ENV_KEYS.filter(k => process.env[k]);
  if (found.length) {
    const msg = `[agent] no-keys guard: refusing to run — paid API keys present in env: ${found.join(', ')}`;
    console.error(msg);
    return { ok: false, error: msg, blocked: found };
  }
  return { ok: true };
}

module.exports = { checkNoKeysGuard, BLOCKED_ENV_KEYS };
