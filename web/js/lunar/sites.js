// Clearway Lunar — candidate landing sites.
// The south-pole set is the focus of the challenge; two flown CLPS landings away from the pole
// (IM-1 near Malapert A and Blue Ghost Mission 1 in Mare Crisium) are included for contrast.
// Any latitude can be added in the app. Coordinates are in the Mean Earth frame, east longitude. Every entry
// cites a primary source: named features from the USGS/IAU Gazetteer of Planetary Nomenclature (the
// official register of planetary names), landing sites from NASA and the LRO camera (LROC) team, which
// located the landers in orbital images. NASA's Artemis III candidate *regions* (October 2024) are
// ~15 km boxes near these features; their exact boundaries are not reproduced here.

const GAZ = (id, name) => `USGS/IAU Gazetteer of Planetary Nomenclature, feature ${id} (${name}), first-listed control-network centre — planetarynames.wr.usgs.gov/Feature/${id}`;

export const SITES = [
  { id: 'im2', name: 'IM-2 Athena landing site', short: 'IM-2', lat: -84.7906, lon: 29.1957, kind: 'CLPS landing (6 Mar 2025)',
    note: 'Intuitive Machines IM-2 touchdown on Mons Mouton, located in LRO camera images.', source: 'NASA LRO / LROC image 1408 "IM-2 Athena Seen Obliquely" (84.7906°S, 29.1957°E)' },
  { id: 'mouton', name: 'Mons Mouton', short: 'Mouton', lat: -84.6, lon: 31.0, kind: 'Artemis III region: Mons Mouton',
    note: 'Flat-topped massif about 5 km high; this is the official feature centre on its plateau, not the exact summit.', source: GAZ(16070, 'Mons Mouton') },
  { id: 'malapert', name: 'Malapert Massif region', short: 'Malapert', lat: -86.0, lon: 0.0, kind: 'Artemis III region: Malapert Massif',
    note: 'Heart of the Artemis III Malapert region; the massif faces Earth.', source: 'NASA LRO / LROC image 1294 "Malapert Massif" (86°S, 0°E)' },
  { id: 'shackleton', name: 'Shackleton crater (centre)', short: 'Shackleton', lat: -89.67, lon: 129.78, kind: 'Permanently shadowed floor',
    note: 'Crater floor near the pole; a contrast case for the sunlit rim.', source: GAZ(5450, 'Shackleton') },
  { id: 'degerlache', name: 'de Gerlache crater', short: 'de Gerlache', lat: -88.48, lon: -88.34, kind: 'Artemis III region: de Gerlache Rim 2',
    note: 'Crater centre; the Artemis region lies on its rim.', source: GAZ(1439, 'de Gerlache') },
  { id: 'haworth', name: 'Haworth crater', short: 'Haworth', lat: -86.9, lon: -4.0, kind: 'Artemis III region: Haworth',
    note: 'Crater centre; the Artemis region lies near the rim.', source: GAZ(14502, 'Haworth') },
  { id: 'nobile', name: 'Nobile crater', short: 'Nobile', lat: -85.28, lon: 53.27, kind: 'Artemis III regions: Nobile Rim 1 & 2',
    note: 'Crater centre; two Artemis regions lie on its rim.', source: GAZ(4321, 'Nobile') },
  { id: 'slater', name: 'Slater crater', short: 'Slater', lat: -88.08, lon: 111.29, kind: 'Artemis III region: Slater Plain',
    note: 'Crater centre next to the Slater Plain region.', source: GAZ(15325, 'Slater') },
  { id: 'cabeusb', name: 'Cabeus B', short: 'Cabeus B', lat: -82.26, lon: -54.58, kind: 'Artemis III region: Peak near Cabeus B',
    note: 'Satellite crater centre; the Artemis region is a nearby peak.', source: GAZ(8058, 'Cabeus B') },
  { id: 'im1', name: 'IM-1 Odysseus landing site', short: 'IM-1', lat: -80.13, lon: 1.44, kind: 'CLPS landing (22 Feb 2024)',
    note: 'Intuitive Machines IM-1 touchdown near Malapert A; the first CLPS landing. NASA reports 2,579 m elevation and a 12° local slope.', source: 'NASA, "NASA\'s LRO Images Intuitive Machines\' Odysseus Lander" (80.13°S, 1.44°E)', region: 'polar' },
  { id: 'blueghost', name: 'Blue Ghost Mission 1 site', short: 'Blue Ghost', lat: 18.5623, lon: 61.8103, kind: 'CLPS landing (2 Mar 2025)',
    note: 'Firefly Blue Ghost M1 in Mare Crisium near Mons Latreille: a mid-latitude contrast case with a 14-day lunar day and night.', source: 'NASA LRO / LROC image 1407 "Blue Ghost Lunar Lander Seen From Above" (18.5623°N, 61.8103°E)', region: 'nearside', on: false },
  { id: 'ch3', name: 'Chandrayaan-3 Vikram landing site', short: 'Chandrayaan-3', lat: -69.3741, lon: 32.32, kind: 'ISRO landing (23 Aug 2023)',
    note: 'Vikram touched down here on 23 Aug 2023, about 600 km from the south pole: a normal lunar day and night rather than polar lighting. Used for the historical analysis in About → Chandrayaan-3.', source: 'NASA LRO / LROC image 1314 "Chandrayaan-3 Landing Site" (69.3741°S, 32.32°E, 532 m)', region: 'south', on: false },
  { id: 'pole', name: 'Lunar south pole', short: 'Pole', lat: -90, lon: 0, kind: 'Reference point',
    note: 'The geographic south pole, on the rim of Shackleton.', source: 'Definition (90°S)' },
];

/** Sites ticked by default: the south-pole set (mid-latitude contrast sites are opt-in). */
export const isPolar = (s) => s.lat <= -75;

export const siteById = (id) => SITES.find((s) => s.id === id);
