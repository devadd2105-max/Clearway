// Launch site presets. Coordinates are approximate public values.
// Azimuth corridors are typical published ranges for that range and are NOT a substitute
// for the range safety office's approved limits. `corridor: null` means "not configured":
// the planner will accept any azimuth and flag that the corridor must be confirmed.

export const SITES = [
  { id: 'ccsfs-40', name: 'Cape Canaveral SFS, SLC-40', country: 'United States', lat: 28.5619, lon: -80.5772, altM: 5, corridor: { min: 35, max: 120 } },
  { id: 'ksc-39a', name: 'Kennedy Space Center, LC-39A', country: 'United States', lat: 28.6082, lon: -80.6041, altM: 5, corridor: { min: 35, max: 120 } },
  { id: 'vsfb-4e', name: 'Vandenberg SFB, SLC-4E', country: 'United States', lat: 34.6321, lon: -120.6106, altM: 120, corridor: { min: 147, max: 201 } },
  { id: 'wallops-0a', name: 'Wallops / MARS, LP-0A', country: 'United States', lat: 37.8338, lon: -75.4881, altM: 5, corridor: { min: 38, max: 130 } },
  { id: 'kodiak', name: 'Pacific Spaceport Complex, Kodiak', country: 'United States', lat: 57.4357, lon: -152.3378, altM: 50, corridor: { min: 110, max: 220 } },
  { id: 'kourou', name: 'Guiana Space Centre, ELA-4', country: 'France / ESA', lat: 5.2603, lon: -52.7848, altM: 20, corridor: { min: 349.5, max: 93.5 } },
  { id: 'mahia', name: 'Rocket Lab LC-1, Mahia', country: 'New Zealand', lat: -39.2606, lon: 177.8649, altM: 60, corridor: null },
  { id: 'sriharikota', name: 'Satish Dhawan SC, Sriharikota', country: 'India', lat: 13.7199, lon: 80.2304, altM: 5, corridor: null },
  { id: 'tanegashima', name: 'Tanegashima, Yoshinobu LC', country: 'Japan', lat: 30.4009, lon: 130.9774, altM: 20, corridor: null },
  { id: 'naro', name: 'Naro Space Center', country: 'South Korea', lat: 34.4317, lon: 127.5350, altM: 100, corridor: null },
  { id: 'wenchang', name: 'Wenchang, LC-101', country: 'China', lat: 19.6145, lon: 110.9510, altM: 10, corridor: null },
  { id: 'jiuquan', name: 'Jiuquan SLC', country: 'China', lat: 40.9606, lon: 100.2983, altM: 1000, corridor: null },
  { id: 'baikonur', name: 'Baikonur Cosmodrome, Site 31', country: 'Kazakhstan / Russia', lat: 45.9960, lon: 63.5640, altM: 100, corridor: null },
  { id: 'plesetsk', name: 'Plesetsk Cosmodrome', country: 'Russia', lat: 62.9271, lon: 40.5777, altM: 130, corridor: null },
  { id: 'custom', name: 'Custom site…', country: '', lat: 0, lon: 0, altM: 0, corridor: null },
];

export const siteById = (id) => SITES.find((s) => s.id === id) || SITES[0];
