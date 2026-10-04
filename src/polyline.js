// Hilfsfunktionen für Linien: Vereinfachung (Douglas-Peucker) und
// Google-Polyline-Kodierung (kompakt für die Übertragung an den Browser).

/** Vereinfacht [[lat, lon], …] mit Toleranz in Metern. */
export function simplify(coords, toleranceM) {
  if (coords.length <= 2) return coords;
  const lat0 = (coords[0][0] * Math.PI) / 180;
  const kx = 111320 * Math.cos(lat0), ky = 110540;
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack = [[0, coords.length - 1]];
  const tol2 = toleranceM * toleranceM;
  while (stack.length) {
    const [i, j] = stack.pop();
    const ax = coords[i][1] * kx, ay = coords[i][0] * ky;
    const bx = coords[j][1] * kx, by = coords[j][0] * ky;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let worst = -1, worstD = tol2;
    for (let k = i + 1; k < j; k++) {
      const px = coords[k][1] * kx - ax, py = coords[k][0] * ky - ay;
      let d2;
      if (len2 === 0) d2 = px * px + py * py;
      else {
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
        const ex = px - t * dx, ey = py - t * dy;
        d2 = ex * ex + ey * ey;
      }
      if (d2 > worstD) { worstD = d2; worst = k; }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([i, worst], [worst, j]);
    }
  }
  return coords.filter((_, k) => keep[k]);
}

export function encode(coords) {
  let out = '', plat = 0, plon = 0;
  const enc = (v) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    while (v >= 0x20) { out += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    out += String.fromCharCode(v + 63);
  };
  for (const [lat, lon] of coords) {
    const a = Math.round(lat * 1e5), b = Math.round(lon * 1e5);
    enc(a - plat); enc(b - plon);
    plat = a; plon = b;
  }
  return out;
}

export function decode(str) {
  const coords = [];
  let i = 0, lat = 0, lon = 0;
  const dec = () => {
    let result = 0, shift = 0, b;
    do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < str.length) {
    lat += dec(); lon += dec();
    coords.push([lat / 1e5, lon / 1e5]);
  }
  return coords;
}
