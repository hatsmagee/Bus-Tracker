'use strict';
/**
 * Build data/osm/route-roads.geojson: the subset of real OSM road ways that at
 * least one bus route travels, each as a LineString whose GeoJSON feature `id`
 * IS the OSM way id. This is the join key the client uses to COLOR THE ACTUAL
 * ROAD: the map loads these as a source with promoteId, then setFeatureState on
 * a way id recolors that exact road line (same OSM geometry the basemap draws,
 * so it can never be off-road). Ways used by 2+ routes are additionally drawn as
 * tight parallel ribbon bands (one line can't be two colors).
 *
 * Depends on data/osm/bigisland-roads.json (full-res road geometry) and
 * data/route-edges.json (which carries wayId per edge). Rebuild both first if
 * routes or roads changed.
 *
 * Usage: node scripts/build-route-roads-geojson.js
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const roads = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/osm/bigisland-roads.json'), 'utf8'));
const routeEdges = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/route-edges.json'), 'utf8'));

const usedWays = new Set(routeEdges.edges.map(e => e.wayId).filter(w => w != null));
const features = roads
  .filter(w => usedWays.has(w.id))
  .map(w => ({ type: 'Feature', id: w.id, properties: { wayId: w.id }, geometry: { type: 'LineString', coordinates: w.coords } }));

const outPath = path.join(ROOT, 'data/osm/route-roads.geojson');
fs.writeFileSync(outPath, JSON.stringify({ type: 'FeatureCollection', features }));
const missing = [...usedWays].filter(w => !roads.some(r => r.id === w)).length;
console.log(`Wrote ${features.length} route-road ways -> ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(0)} KB)`);
console.log(`  used wayIds: ${usedWays.size}, missing geometry: ${missing}`);
