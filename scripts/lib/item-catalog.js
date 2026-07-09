'use strict';

// Catalog of every named map pin that should carry agent-researched history +
// photos. See scripts/agent/ENRICHMENT_POLICY.md — enrichment is mandatory for
// all sites of interest, not optional garnish.

const { REFERENCE_PATH, HERITAGE_SITES_PATH, ASSET_MEDIA_PATH } = require('./paths');
const { readJsonFile } = require('./map-items-schema');
const { heritageKey, assetKey, mobilityKey } = require('./enrichment-policy');

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
    ['ocean:51207', 'NDBC 51207 — Kaneohe (Oʻahu)'],
    ['ocean:51201', 'NDBC 51201 — Waimea Bay (Oʻahu)'],
    ['ocean:51205', 'NDBC 51205 — Pauwela (Maui)'],
    ['ocean:51208', 'NDBC 51208 — Hanalei (Kauaʻi)'],
    ['ocean:51210', 'NDBC 51210 — Kaneʻohe Bay (Oʻahu)'],
    ['ocean:51407', 'DART 51407 tsunami buoy — W of Kona'],
    ['ocean:1617760', 'Hilo Bay tide station'],
    ['ocean:1617433', 'Kawaihae tide station'],
    ['ocean:1612480', 'Kailua-Kona tide station'],
    ['ocean:1611400', 'Nāwiliwili Harbor tide (Kauaʻi)'],
    ['ocean:1612340', 'Honolulu Harbor tide (Oʻahu)'],
    ['ocean:1615680', 'Kahului Harbor tide (Maui)'],
  ];
  for (const [key, title] of buoys) items.push(mk(key, title, { researchQuery: title }));

  const plants = [
    ['power:pakinigui', 'Pakini Nui Wind Farm'],
    ['power:hawiwind', 'Hawi Wind Farm'],
    ['power:aes-waikoloa', 'AES Waikoloa Solar'],
    ['power:hakalau-hydro', 'Hakalau Hydro'],
    ['power:kahe', 'Kahe Generating Station (Oʻahu)'],
    ['power:waiau', 'Waiau Power Plant (Oʻahu)'],
    ['power:aes-west-oahu', 'AES West Oʻahu Solar'],
    ['power:kahului', 'Kahului Power Plant (Maui)'],
    ['power:maalaea', 'Māʻalaea Generating Station (Maui)'],
    ['power:auwahi-wind', 'Auwahi Wind Farm (Maui)'],
    ['power:port-allen', 'Port Allen Power Plant (Kauaʻi)'],
    ['power:koloa-solar', 'Kōloa Solar (Kauaʻi)'],
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

  // Neighbor-island landmarks. The tracker is Big-Island-centric, but these are
  // famous, well-documented places across the rest of the Hawaiian chain — rich
  // research targets (real history + photos) that let the agent's enrichment
  // spread statewide. Coordinates live in scripts/lib/item-coords.js.
  const neighborIslands = [
    // Maui
    ['maui:haleakala', 'Haleakalā (Maui)', 'Haleakalā National Park volcano Maui'],
    ['maui:iao', 'ʻĪao Valley & ʻĪao Needle (Maui)', 'Iao Valley State Monument Maui'],
    ['maui:lahaina', 'Lahaina Historic District (Maui)', 'Lahaina Hawaii historic whaling town'],
    ['maui:hana', 'Hāna & the Hāna Highway (Maui)', 'Hana Highway Road to Hana Maui'],
    ['maui:molokini', 'Molokini Crater (Maui)', 'Molokini islet crater Hawaii'],
    ['maui:ogg', 'Kahului Airport (Maui)', 'Kahului Airport Maui history'],
    // Oʻahu
    ['oahu:diamondhead', 'Diamond Head / Lēʻahi (Oʻahu)', 'Diamond Head Leahi Honolulu Hawaii'],
    ['oahu:pearlharbor', 'Pearl Harbor & USS Arizona Memorial (Oʻahu)', 'Pearl Harbor USS Arizona Memorial'],
    ['oahu:waikiki', 'Waikīkī Beach (Oʻahu)', 'Waikiki Honolulu history'],
    ['oahu:iolani', 'ʻIolani Palace (Oʻahu)', 'Iolani Palace Honolulu Kingdom of Hawaii'],
    ['oahu:palilookout', 'Nuʻuanu Pali Lookout (Oʻahu)', 'Nuuanu Pali Battle of Nuuanu Oahu'],
    ['oahu:hanauma', 'Hanauma Bay (Oʻahu)', 'Hanauma Bay Nature Preserve Oahu'],
    ['oahu:hnl', 'Daniel K. Inouye International Airport (Oʻahu)', 'Honolulu International Airport history'],
    // Kauaʻi
    ['kauai:waimeacanyon', 'Waimea Canyon (Kauaʻi)', 'Waimea Canyon Kauai Grand Canyon of the Pacific'],
    ['kauai:napali', 'Nā Pali Coast (Kauaʻi)', 'Na Pali Coast State Park Kauai'],
    ['kauai:hanalei', 'Hanalei Bay (Kauaʻi)', 'Hanalei Bay Kauai'],
    ['kauai:wailuafalls', 'Wailua Falls (Kauaʻi)', 'Wailua Falls Kauai'],
    ['kauai:lih', 'Līhuʻe Airport (Kauaʻi)', 'Lihue Airport Kauai history'],
    // Molokaʻi + Lānaʻi
    ['molokai:kalaupapa', 'Kalaupapa National Historical Park (Molokaʻi)', 'Kalaupapa leprosy settlement Molokai Father Damien'],
    ['lanai:keahiakawelo', 'Keahiakawelo / Garden of the Gods (Lānaʻi)', 'Keahiakawelo Garden of the Gods Lanai'],
    ['lanai:hulopoe', 'Hulopoʻe Bay (Lānaʻi)', 'Hulopoe Bay Lanai marine preserve'],
  ];
  for (const [key, title, researchQuery] of neighborIslands) items.push(mk(key, title, { researchQuery }));

  const aq = [
    'Hilo', 'Kailua-Kona', 'Volcano', 'Pāhala', 'Ocean View', 'Waimea', 'Waikoloa', 'Pāhoa', 'Captain Cook',
    'Honolulu', 'Kaneohe', 'Wailuku', 'Lihue', 'Princeville', 'Lanai City',
  ];
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

  const heritageDoc = readJsonFile(HERITAGE_SITES_PATH, { sites: [] });
  for (const s of (heritageDoc.sites || [])) {
    const title = s.name;
    const wiki = s.wiki || title;
    items.push(mk(heritageKey(title), title, {
      researchQuery: `${wiki} Hawaii history`,
      priority: 'high',
    }));
  }

  const assetDoc = readJsonFile(ASSET_MEDIA_PATH, { assets: [] });
  for (const a of (assetDoc.assets || [])) {
    const id = a.id || a.icao || a.match;
    if (!id) continue;
    const title = a.wiki || String(a.match || id);
    items.push(mk(assetKey(id), title, {
      researchQuery: `${title} Hawaii`,
      priority: 'high',
    }));
  }

  for (const [id, name, query] of [
    ['hibike', 'HIBIKE bikeshare (Big Island)', 'HIBIKE Hawaii Island bikeshare history'],
    ['biki', 'Biki bikeshare (Honolulu)', 'Biki Honolulu bikeshare history'],
  ]) {
    items.push(mk(mobilityKey(id), name, { researchQuery: query, priority: 'medium' }));
  }

  items.push(mk('category:places', 'Historical & notable places (Wikipedia)', {
    researchQuery: 'Big Island Hawaii historical places landmarks',
    categoryLevel: true,
  }));
  items.push(mk('category:heritage', 'Heritage & ancient sites (curated atlas)', {
    researchQuery: 'Hawaii Island heiau historic sites National Park',
    categoryLevel: true,
  }));
  items.push(mk('category:repeaters', 'Ham radio repeaters statewide', {
    researchQuery: 'Amateur radio repeaters Hawaii',
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
