#!/usr/bin/env node
'use strict';
require('../publish-map-items').publish()
  .then(r => process.exit(r.ok ? 0 : 1))
  .catch(e => { console.error(e); process.exit(1); });
