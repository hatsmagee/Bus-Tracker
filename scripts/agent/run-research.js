#!/usr/bin/env node
'use strict';
// Entrypoint for a research cycle. Prints the result so the server's activity
// log (which captures this process's stdout) shows what happened, not just
// start/finish markers.
require('./research-agent').runResearchCycle()
  .then(r => {
    console.log('[research] ' + JSON.stringify(r));
    process.exit(r.ok ? 0 : 1);
  })
  .catch(e => { console.error('[research] error:', e && e.stack || e); process.exit(1); });
