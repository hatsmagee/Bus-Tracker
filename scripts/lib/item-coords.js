'use strict';
// Fixed map coordinates for the agent's catalog items, keyed by `category:id`.
// Used to place the roaming research scout next to what it's actually working
// on. Geographic points across the Hawaiian chain belong here — off-island
// deep-ocean buoys, moving satellites, and non-geographic category items are
// intentionally omitted so the scout stays hidden for those instead of flying
// off the map.
//
// Coordinates are [lon, lat]. Statewide bounding box (covers every main island,
// so the scout can roam from Kauaʻi to the Big Island):
const BBOX = { minLat: 18.8, maxLat: 22.35, minLon: -159.9, maxLon: -154.7 };

const COORDS = {
  // Maunakea + Mauna Loa summit facilities
  'summit:cfht': [-155.4689, 19.8253],
  'summit:ukirt': [-155.4700, 19.8225],
  'summit:irtf': [-155.4719, 19.8262],
  'summit:subaru': [-155.4761, 19.8255],
  'summit:keck': [-155.4747, 19.8263],
  'summit:jcmt': [-155.4771, 19.8218],
  'summit:sma': [-155.4782, 19.8242],
  'summit:vlba': [-155.4556, 19.8014],
  'summit:hpohaku': [-155.4560, 19.7605],
  'summit:mlo': [-155.5763, 19.5362],

  // On/near-island ocean stations (offshore DART/NDBC buoys omitted on purpose)
  'ocean:51206': [-154.9700, 19.7800],  // Hilo Waverider
  'ocean:1617760': [-155.0600, 19.7300], // Hilo Bay tide
  'ocean:1617433': [-155.8290, 20.0360], // Kawaihae tide
  'ocean:1612480': [-156.0000, 19.6400], // Kailua-Kona tide

  // Power / renewables
  'power:pakinigui': [-155.6700, 18.9800],   // Pakini Nui (South Point)
  'power:hawiwind': [-155.8500, 20.2200],     // Hawi / Upolu Point
  'power:aes-waikoloa': [-155.7900, 19.9200], // Waikoloa solar
  'power:hakalau-hydro': [-155.1300, 19.9000],// Hakalau

  // Kīlauea + Mauna Loa webcams
  'volcano:KWcam': [-155.2870, 19.4210],
  'volcano:V1cam': [-155.2830, 19.4190],
  'volcano:V2cam': [-155.2790, 19.4200],
  'volcano:V3cam': [-155.2810, 19.4150],
  'volcano:KOcam': [-155.2600, 19.4080],
  'volcano:MKcam': [-155.6080, 19.4750],
  'volcano:MSPcam': [-155.6000, 19.4600],
  'volcano:HLcam': [-155.6200, 19.5500],

  // Air-quality towns
  'airquality:Hilo': [-155.0800, 19.7100],
  'airquality:Kailua-Kona': [-156.0000, 19.6400],
  'airquality:Volcano': [-155.2300, 19.4400],
  'airquality:Pāhala': [-155.4800, 19.2000],
  'airquality:Ocean View': [-155.7600, 19.1000],
  'airquality:Waimea': [-155.6700, 20.0200],
  'airquality:Waikoloa': [-155.7900, 19.9400],
  'airquality:Pāhoa': [-154.9500, 19.4900],
  'airquality:Captain Cook': [-155.9200, 19.5000],
  'airquality:Honolulu': [-157.8580, 21.3060],
  'airquality:Kaneohe': [-157.8030, 21.4180],
  'airquality:Wailuku': [-156.5040, 20.8910],
  'airquality:Lihue': [-159.3710, 21.9760],
  'airquality:Princeville': [-159.4780, 22.2170],
  'airquality:Lanai City': [-156.9210, 20.8270],

  // Neighbor-island ocean stations
  'ocean:51201': [-158.1170, 21.6710],
  'ocean:51205': [-156.4250, 21.0190],
  'ocean:51208': [-159.5740, 22.2850],
  'ocean:51210': [-157.7560, 21.4770],
  'ocean:51207': [-157.7500, 21.4800],

  // Neighbor-island power plants
  'power:kahe': [-158.1240, 21.3550],
  'power:waiau': [-157.9750, 21.3880],
  'power:aes-west-oahu': [-158.1100, 21.3650],
  'power:kahului': [-156.4580, 20.8840],
  'power:maalaea': [-156.5080, 20.7920],
  'power:auwahi-wind': [-156.3650, 20.6050],
  'power:port-allen': [-159.5930, 21.8970],
  'power:koloa-solar': [-159.4650, 21.8830],

  // Blyncsy traffic sensors (Hilo corridor)
  'sensor:bly-hilo-1': [-155.0890, 19.7250],
  'sensor:bly-hilo-2': [-155.0770, 19.6960],
  'sensor:bly-hilo-3': [-155.0740, 19.6930],
  'sensor:bly-hilo-4': [-155.0400, 19.6230],
  'sensor:bly-hilo-5': [-155.0820, 19.7050],
  'sensor:bly-hilo-6': [-155.0370, 19.6210],

  // Maui
  'maui:haleakala': [-156.2533, 20.7097],
  'maui:iao': [-156.5450, 20.8790],
  'maui:lahaina': [-156.6789, 20.8783],
  'maui:hana': [-155.9903, 20.7580],
  'maui:molokini': [-156.4958, 20.6314],
  'maui:ogg': [-156.4304, 20.8986],

  // Oʻahu
  'oahu:diamondhead': [-157.8055, 21.2620],
  'oahu:pearlharbor': [-157.9500, 21.3649],
  'oahu:waikiki': [-157.8267, 21.2769],
  'oahu:iolani': [-157.8617, 21.3069],
  'oahu:palilookout': [-157.7936, 21.3667],
  'oahu:hanauma': [-157.6939, 21.2690],
  'oahu:hnl': [-157.9224, 21.3187],

  // Kauaʻi
  'kauai:waimeacanyon': [-159.6607, 22.0781],
  'kauai:napali': [-159.6200, 22.1700],
  'kauai:hanalei': [-159.5010, 22.2050],
  'kauai:wailuafalls': [-159.3780, 22.0350],
  'kauai:lih': [-159.3390, 21.9760],

  // Molokaʻi + Lānaʻi
  'molokai:kalaupapa': [-156.9700, 21.1900],
  'lanai:keahiakawelo': [-156.9400, 20.8600],
  'lanai:hulopoe': [-156.8900, 20.7400],

  // Neighbor-island harbor tide gauges
  'ocean:1611400': [-159.3558, 21.9544],
  'ocean:1612340': [-157.8670, 21.3067],
  'ocean:1615680': [-156.4767, 20.8950],
};

function inBox(lon, lat) {
  return lat >= BBOX.minLat && lat <= BBOX.maxLat && lon >= BBOX.minLon && lon <= BBOX.maxLon;
}

// Return [lon, lat] for a catalog key if it's a known on-island point, else null.
// An optional resolver (e.g. one backed by the server's REFERENCE data) is tried
// for hub:/pnr:/airport: keys whose coordinates live in that reference file.
function coordFor(key, resolver) {
  const direct = COORDS[key];
  if (direct && inBox(direct[0], direct[1])) return direct;
  if (typeof resolver === 'function') {
    const r = resolver(key);
    if (Array.isArray(r) && r.length === 2 && inBox(r[0], r[1])) return r;
  }
  return null;
}

module.exports = { COORDS, BBOX, coordFor, inBox };
