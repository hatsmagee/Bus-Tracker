#!/usr/bin/env node
'use strict';
// Entrypoint for a publish cycle. Prints the result so the server's activity log
// shows the gate/PR outcome.
require('../publish-map-items').publish()
  .then(r => {
    console.log('[publish] ' + JSON.stringify(r));
    process.exit(r.ok ? 0 : 1);
  })
  .catch(e => { console.error('[publish] error:', e && e.stack || e); process.exit(1); });
