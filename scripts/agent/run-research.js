#!/usr/bin/env node
'use strict';
require('./research-agent').runResearchCycle()
  .then(r => process.exit(r.ok ? 0 : 1))
  .catch(e => { console.error(e); process.exit(1); });
