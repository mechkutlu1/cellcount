/* =====================================================================
   Synthetic bright-field microscopy fields with exact ground truth.
   Used by train.js and test.js. Cells are drawn as refractile discs
   (bright centre, dark rim) on an unevenly lit ground, which is what a
   hemocytometer under a 10x objective actually looks like; dead cells
   are filled blue to mimic trypan uptake. Debris is deliberately
   included, because rejecting it is the classifier's whole job.
   ===================================================================== */
/* UMD: the browser uses this for Demo mode, so a user with no microscope can
   verify the engine against known ground truth before trusting a real sample. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Synth = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function makeField(opts) {
  const o = Object.assign({
    width: 720, height: 540, seed: 1,
    nCells: 60, cellDiaPx: 24, diaJitter: 0.18,
    deadFrac: 0.0, nDebris: 12, clusterFrac: 0.25,
    noise: 6, vignette: 0.35, bg: 205,
  }, opts || {});
  const rnd = mulberry32(o.seed);
  const w = o.width, h = o.height;
  const data = new Uint8ClampedArray(w * h * 4);

  // uneven illumination: radial vignette + a gradient
  const cx = w * (0.45 + 0.1 * rnd()), cy = h * (0.45 + 0.1 * rnd());
  const maxR = Math.hypot(w, h) / 2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const r = Math.hypot(x - cx, y - cy) / maxR;
    const v = o.bg * (1 - o.vignette * r * r) * (0.95 + 0.1 * (x / w));
    const i = (y * w + x) * 4;
    data[i] = data[i+1] = data[i+2] = v; data[i+3] = 255;
  }

  const truth = [];
  const place = (px, py, rad, isDead) => {
    const r2 = rad, rimIn = rad * 0.72;
    for (let y = Math.max(0, Math.floor(py - r2 - 2)); y < Math.min(h, py + r2 + 2); y++)
      for (let x = Math.max(0, Math.floor(px - r2 - 2)); x < Math.min(w, px + r2 + 2); x++) {
        const dd = Math.hypot(x - px, y - py);
        if (dd > r2) continue;
        const i = (y * w + x) * 4;
        if (isDead) {                                  // trypan-stained: dark blue disc
          data[i]   = data[i] * 0.35;
          data[i+1] = data[i+1] * 0.42;
          data[i+2] = Math.min(255, data[i+2] * 0.85 + 30);
        } else if (dd > rimIn) {                       // refractile rim: dark
          const k = 0.45 + 0.25 * (r2 - dd) / (r2 - rimIn);
          data[i] *= k; data[i+1] *= k; data[i+2] *= k;
        } else {                                       // bright interior
          const k = 1.06;
          data[i] = Math.min(255, data[i]*k); data[i+1] = Math.min(255, data[i+1]*k);
          data[i+2] = Math.min(255, data[i+2]*k);
        }
      }
    truth.push({ x: px, y: py, r: rad, dead: !!isDead });
  };

  const rad = () => o.cellDiaPx / 2 * (1 + o.diaJitter * (rnd() * 2 - 1));
  let placed = 0, guard = 0;
  while (placed < o.nCells && guard++ < o.nCells * 200) {
    const r = rad();
    const px = r + rnd() * (w - 2 * r), py = r + rnd() * (h - 2 * r);
    // keep centres apart so ground truth is unambiguous, unless clustering
    let clash = false;
    for (const t of truth) if (Math.hypot(t.x - px, t.y - py) < (t.r + r) * 0.98) { clash = true; break; }
    if (clash) continue;
    place(px, py, r, rnd() < o.deadFrac);
    placed++;
    // touching pair: a second cell just overlapping the first
    if (rnd() < o.clusterFrac && placed < o.nCells) {
      const r2 = rad(), ang = rnd() * Math.PI * 2, sep = (r + r2) * (0.72 + 0.16 * rnd());
      const qx = px + sep * Math.cos(ang), qy = py + sep * Math.sin(ang);
      if (qx > r2 && qy > r2 && qx < w - r2 && qy < h - r2) {
        let clash2 = false;
        for (const t of truth) if (t.x !== px && Math.hypot(t.x - qx, t.y - qy) < (t.r + r2) * 0.7) clash2 = true;
        if (!clash2) { place(qx, qy, r2, rnd() < o.deadFrac); placed++; }
      }
    }
  }

  // debris: small specks and large irregular junk (neither is a cell)
  const debris = [];
  for (let k = 0; k < o.nDebris; k++) {
    const big = rnd() < 0.4;
    const px = rnd() * w, py = rnd() * h;
    const rr = big ? o.cellDiaPx * (0.9 + rnd() * 0.9) : o.cellDiaPx * (0.1 + rnd() * 0.18);
    const lobes = big ? 3 + Math.floor(rnd() * 3) : 1;
    const dk = 0.32 + rnd() * 0.5;   // varied darkness, overlapping cell rims
    for (let l = 0; l < lobes; l++) {
      const ox = px + (rnd() - 0.5) * rr, oy = py + (rnd() - 0.5) * rr;
      const lr = rr * (0.3 + rnd() * 0.5);
      for (let y = Math.max(0, Math.floor(oy - lr)); y < Math.min(h, oy + lr); y++)
        for (let x = Math.max(0, Math.floor(ox - lr)); x < Math.min(w, ox + lr); x++) {
          if (Math.hypot(x - ox, y - oy) > lr) continue;
          const i = (y * w + x) * 4;
          data[i] *= dk; data[i+1] *= dk; data[i+2] *= dk + 0.03;
        }
    }
    debris.push({ x: px, y: py, r: rr });
  }

  for (let i = 0; i < w * h; i++) {
    const j = i * 4, n = (rnd() * 2 - 1) * o.noise;
    data[j] += n; data[j+1] += n; data[j+2] += n;
  }
  return { image: { width: w, height: h, data }, truth, debris, opts: o };
}

/* Ground-truth count under the hemocytometer edge rule: a cell whose centre
   lies in the field counts, unless its disc touches the right/bottom border. */
function truthCount(field, edgeRule) {
  const { width: w, height: h } = field.image;
  return field.truth.filter(t =>
    !(edgeRule && (t.x + t.r >= w - 2 || t.y + t.r >= h - 2))).length;
}

return { makeField, truthCount, mulberry32 };
}));
