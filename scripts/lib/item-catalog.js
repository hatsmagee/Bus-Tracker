'use strict';

const { REFERENCE_PATH } = require('./paths');
const { readJsonFile } = require('./map-items-schema');

function mk(key, title, extra = {}) {
  return { key, title, ...extra };
}

function staticCatalog() {
  const items = [];

  const summits = [
    ['summit:cfht', 'CFHT / Gemini North', { researchQuery: 'Canada-France-Hawaii Telescope Maunakea' }],
    ['summit:ukirt', 'UKIRT Infrared Telescope', { researchQuery: 'UKIRT Maunakea' }],
    ['summit:irtf', 'NASA Infrared Telescope Facility', { researchQuery: 'IRTF Maunakea' }],
    ['summit:subaru', 'Subaru Telescope', { researchQuery: 'Subaru Telescope Maunakea' }],
    ['summit:keck', 'W. M. Keck Observatory', { researchQuery: 'Keck Observatory Maunakea' }],
    ['summit:jcmt', 'James Clerk Maxwell Telescope', { researchQuery: 'JCMT Maunakea' }],
    ['summit:sma', 'Submillimeter Array', { researchQuery: 'Submillimeter Array Maunakea' }],
    ['summit:vlba', 'VLBA Station Maunakea', { researchQuery: 'VLBA Maunakea' }],
    ['summit:hpohaku', 'Hale Pōhaku', { researchQuery: 'Hale Pohaku Maunakea mid-level facility' }],
    ['summit:mlo', 'Mauna Loa Observatory', { researchQuery: 'Mauna Loa Observatory NOAA Keeling Curve' }],
  ];
  for (const [key, title, extra] of summits) items.push(mk(key, title, extra));

  const lco = [
    ['lco:ogg', 'LCO Haleakalā (Maui)'],
    ['lco:lsc', 'LCO Cerro Tololo (Chile)'],
    ['lco:coj', 'LCO Siding Spring (Australia)'],
    ['lco:elp', 'LCO McDonald (Texas)'],
    ['lco:tfn', 'LCO Teide (Canary Islands)'],
    ['lco:sqa', 'LCO Sutherland (South Africa)'],
  ];
  for (const [key, title] of lco) items.push(mk(key, title, { researchQuery: title }));

  const buoys = [
    ['ocean:51000', 'NDBC 51000 — N of Hawaii'],
    ['ocean:51001', 'NDBC 51001 — NW Hawaii'],
    ['ocean:51002', 'NDBC 51002 — S of Hawaii'],
    ['ocean:51004', 'NDBC 51004 — SE of Hawaii'],
    ['ocean:51206', 'NDBC 51206 — Hilo Waverider'],
    ['ocean:51207', 'NDBC 51207 — Kaneohe'],
    ['ocean:51407', 'DART 51407 tsunami buoy — W of Kona'],
    ['ocean:1617760', 'Hilo Bay tide station'],
    ['ocean:1617433', 'Kawaihae tide station'],
    ['ocean:1612480', 'Kailua-Kona tide station'],
  ];
  for (const [key, title] of buoys) items.push(mk(key, title, { researchQuery: title }));

  const plants = [
    ['power:pakinigui', 'Pakini Nui Wind Farm'],
    ['power:hawiwind', 'Hawi Wind Farm'],
    ['power:aes-waikoloa', 'AES Waikoloa Solar'],
    ['power:hakalau-hydro', 'Hakalau Hydro'],
  ];
  for (const [key, title] of plants) items.push(mk(key, title, { researchQuery: `${title} Hawaii` }));

  const cams = [
    ['volcano:KWcam', 'Halemaʻumaʻu crater west rim webcam'],
    ['volcano:V1cam', 'Kīlauea west Halemaʻumaʻu PTZ webcam'],
    ['volcano:V2cam', 'Kīlauea east Halemaʻumaʻu PTZ webcam'],
    ['volcano:V3cam', 'Kīlauea south Halemaʻumaʻu PTZ webcam'],
    ['volcano:KOcam', 'Kīlauea upper East Rift Zone webcam'],
    ['volcano:MKcam', 'Mauna Loa summit webcam from Mauna Kea'],
    ['volcano:MSPcam', 'Mauna Loa SW Rift webcam'],
    ['volcano:HLcam', 'Mauna Loa NW flank webcam'],
  ];
  for (const [key, title] of cams) items.push(mk(key, title, { researchQuery: `USGS HVO ${title}` }));

  items.push(mk('sat:25544', 'International Space Station', { researchQuery: 'International Space Station history' }));
  items.push(mk('sat:20580', 'Hubble Space Telescope', { researchQuery: 'Hubble Space Telescope history' }));

  const aq = ['Hilo', 'Kailua-Kona', 'Volcano', 'Pāhala', 'Ocean View', 'Waimea', 'Waikoloa', 'Pāhoa', 'Captain Cook'];
  for (const town of aq) items.push(mk(`airquality:${town}`, `${town} air quality`, { researchQuery: `${town} Hawaii history` }));

  const blyncsy = [
    ['sensor:bly-hilo-1', 'Kamehameha Ave / Pauahi (Hilo)'],
    ['sensor:bly-hilo-2', 'Kanoelehua / Puainako'],
    ['sensor:bly-hilo-3', 'Kanoelehua / Makaala'],
    ['sensor:bly-hilo-4', 'Hwy 11 / Keaau-Pahoa Rd'],
    ['sensor:bly-hilo-5', 'Hwy 11 / Railroad Ave'],
    ['sensor:bly-hilo-6', 'Keaau / Hwy 11'],
  ];
  for (const [key, title] of blyncsy) items.push(mk(key, title, { researchQuery: 'Blyncsy Hawaii traffic sensor' }));

  const ref = readJsonFile(REFERENCE_PATH, {});
  for (const h of (ref.hubs || [])) {
    items.push(mk(`hub:${h.name}`, h.name, { researchQuery: `${h.name} Hawaii Hele-On transit` }));
  }
  for (const pr of (ref.parkAndRide || [])) {
    items.push(mk(`pnr:${pr.name}`, pr.name, { researchQuery: `${pr.name} Hawaii park and ride` }));
  }
  for (const a of (ref.airports || [])) {
    items.push(mk(`airport:${a.name}`, a.name, { researchQuery: `${a.name} airport Hawaii history` }));
  }

  items.push(mk('category:repeaters', 'Ham radio repeaters on Hawaiʻi Island', {
    researchQuery: 'Amateur radio repeaters Hawaii Island',
    categoryLevel: true,
  }));
  items.push(mk('category:celltowers', 'Cell towers (OSM)', {
    researchQuery: 'Cellular towers Hawaii Island telecommunications',
    categoryLevel: true,
  }));
  items.push(mk('category:gasstations', 'Gas stations (OSM)', {
    researchQuery: 'Gas stations Hawaii Island',
    categoryLevel: true,
  }));

  return items;
}

module.exports = { staticCatalog, mk };
