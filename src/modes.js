// Verkehrsmittel aus dem GTFS route_type (Basis- und erweiterte Typen).

export const ALL_MODES = ['rail', 'tram', 'metro', 'bus', 'ship', 'cable', 'funicular'];

// Netz, auf dem ein Verkehrsmittel zwischen den Halten geroutet wird
// (Profile in rail-network.js); Luftseilbahnen: Luftlinie.
export const NETWORK_OF = { rail: 'rail', tram: 'rail', metro: 'rail', funicular: 'rail', bus: 'road', ship: 'water' };
export const ROUTED_MODES = new Set(Object.keys(NETWORK_OF));

export function modeOf(type) {
  if (type === 2 || (type >= 100 && type < 200)) return 'rail';
  if (type === 0 || (type >= 900 && type < 1000)) return 'tram';
  if (type === 1 || (type >= 400 && type < 500)) return 'metro';
  if (type === 4 || (type >= 1000 && type < 1300)) return 'ship';
  if (type === 6 || (type >= 1300 && type < 1400)) return 'cable';
  if (type === 7 || (type >= 1400 && type < 1500)) return 'funicular';
  return 'bus'; // 3, 11, 200–299, 700–899, 1500 (Rufbus) …
}

/** Filter für route_types aus einer Liste von Verkehrsmitteln. */
export function modeFilter(modes) {
  const set = new Set(modes);
  return { modes: [...set].sort(), has: (type) => set.has(modeOf(type)) };
}
