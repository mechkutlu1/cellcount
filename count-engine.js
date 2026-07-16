/* =====================================================================
   CellCount — counting engine
   Pure JavaScript, no DOM, no dependencies. Runs in the browser and in
   Node (require) so that training, testing and inference share exactly
   the same feature code.
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CountEngine = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/* ---------- trained weights (see train.js; regenerate, do not hand-edit) ---------- */
/* Logistic regression: P(cell) = sigma(w . x + b), features in FEATURES order. */
let MODEL = {
  "features": [
    "areaRatio",
    "circularity",
    "extent",
    "aspect",
    "dtRatio",
    "contrast",
    "blueness"
  ],
  "mu": [
    1.654411,
    1.197743,
    0.732974,
    1.138336,
    0.968277,
    0.33491,
    0.095419
  ],
  "sigma": [
    1.864471,
    0.237178,
    0.089273,
    0.217169,
    0.423814,
    0.165659,
    0.170094
  ],
  "w": [
    -1.128827,
    -1.743148,
    0.931011,
    -0.996704,
    1.225988,
    -3.510504,
    2.824058
  ],
  "b": 2.689618,
  "trainedOn": "synthetic: 14 fields, 690 blobs, 2026-07-16"
};
function setModel(m) { MODEL = m; }
function getModel() { return MODEL; }

/* ---------- basic image ops ---------- */
// img: {width, height, data:Uint8ClampedArray RGBA}
function downscale(img, targetW) {
  const { width: w, height: h } = img;
  if (w <= targetW) return img;
  const s = targetW / w, nw = Math.round(w * s), nh = Math.round(h * s);
  const out = new Uint8ClampedArray(nw * nh * 4);
  const bx = w / nw, by = h / nh;
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor(y * by), y1 = Math.min(h, Math.ceil((y + 1) * by));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor(x * bx), x1 = Math.min(w, Math.ceil((x + 1) * bx));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const i = (yy * w + xx) * 4; r += img.data[i]; g += img.data[i+1]; b += img.data[i+2]; n++;
      }
      const o = (y * nw + x) * 4;
      out[o] = r / n; out[o+1] = g / n; out[o+2] = b / n; out[o+3] = 255;
    }
  }
  return { width: nw, height: nh, data: out };
}

function toGray(img) {
  const n = img.width * img.height, g = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    g[i] = 0.299 * img.data[j] + 0.587 * img.data[j+1] + 0.114 * img.data[j+2];
  }
  return g;
}

/* Illumination correction: coarse background estimate by box-blur on a
   decimated grid, bilinear upsample, then divide. Microscope fields are
   never evenly lit; without this, Otsu thresholds the vignette. */
function flatField(g, w, h, cell) {
  cell = cell || Math.max(16, Math.round(Math.min(w, h) / 8));
  const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
  const coarse = new Float32Array(gw * gh);
  for (let cy = 0; cy < gh; cy++) for (let cx = 0; cx < gw; cx++) {
    // background := high percentile of the cell (cells are dark on bright field)
    const vals = [];
    for (let y = cy * cell; y < Math.min(h, (cy+1) * cell); y += 2)
      for (let x = cx * cell; x < Math.min(w, (cx+1) * cell); x += 2) vals.push(g[y * w + x]);
    vals.sort((a, b) => a - b);
    coarse[cy * gw + cx] = vals[Math.floor(0.85 * (vals.length - 1))];
  }
  // 3x3 smooth of the coarse grid
  const sm = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    let a = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy < 0 || xx < 0 || yy >= gh || xx >= gw) continue;
      a += coarse[yy * gw + xx]; n++;
    }
    sm[y * gw + x] = a / n;
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(gh - 1.001, Math.max(0, y / cell - 0.5));
    const y0 = Math.floor(fy), ty = fy - y0, y1 = Math.min(gh - 1, y0 + 1);
    for (let x = 0; x < w; x++) {
      const fx = Math.min(gw - 1.001, Math.max(0, x / cell - 0.5));
      const x0 = Math.floor(fx), tx = fx - x0, x1 = Math.min(gw - 1, x0 + 1);
      const b = sm[y0*gw+x0]*(1-tx)*(1-ty) + sm[y0*gw+x1]*tx*(1-ty)
              + sm[y1*gw+x0]*(1-tx)*ty     + sm[y1*gw+x1]*tx*ty;
      out[y * w + x] = b > 1 ? 128 * g[y * w + x] / b : g[y * w + x];
    }
  }
  return out;
}

function otsu(g) {
  const hist = new Float64Array(256);
  for (let i = 0; i < g.length; i++) hist[Math.max(0, Math.min(255, Math.round(g[i])))]++;
  const total = g.length;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; thr = t; }
  }
  return thr;
}

// foreground = darker than threshold (bright-field cells on a light ground)
function threshold(g, w, h, thr) {
  const b = new Uint8Array(w * h);
  for (let i = 0; i < g.length; i++) b[i] = g[i] < thr ? 1 : 0;
  return b;
}

function erode(b, w, h) {
  const o = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    o[i] = (b[i] && b[i-1] && b[i+1] && b[i-w] && b[i+w]) ? 1 : 0;
  }
  return o;
}
function dilate(b, w, h) {
  const o = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    o[i] = (b[i] || b[i-1] || b[i+1] || b[i-w] || b[i+w]) ? 1 : 0;
  }
  return o;
}
const open = (b, w, h) => dilate(erode(b, w, h), w, h);

/* Fill holes: flood the background from the border; anything unreached is
   interior. Live cells under trypan blue appear as bright discs with a dark
   rim, so thresholding yields rings — without this they segment as annuli
   and the distance transform finds two peaks per cell. */
function fillHoles(b, w, h) {
  const seen = new Uint8Array(w * h), st = [];
  const push = i => { if (!b[i] && !seen[i]) { seen[i] = 1; st.push(i); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (st.length) {
    const i = st.pop(), x = i % w, y = (i / w) | 0;
    if (x > 0) push(i - 1); if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w); if (y < h - 1) push(i + w);
  }
  const o = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) o[i] = (b[i] || !seen[i]) ? 1 : 0;
  return o;
}

function labelCC(b, w, h) {
  const lab = new Int32Array(w * h).fill(-1);
  const comps = []; const st = [];
  for (let s = 0; s < w * h; s++) {
    if (!b[s] || lab[s] !== -1) continue;
    const id = comps.length; lab[s] = id; st.length = 0; st.push(s);
    const px = [];
    while (st.length) {
      const i = st.pop(); px.push(i);
      const x = i % w, y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (b[j] && lab[j] === -1) { lab[j] = id; st.push(j); }
      }
    }
    comps.push(px);
  }
  return { lab, comps };
}

/* Chamfer 3-4 distance transform of the foreground. */
function distanceTransform(b, w, h) {
  const INF = 1e9, d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = b[i] ? INF : 0;
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : d[y * w + x];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!b[i]) continue;
    d[i] = Math.min(d[i], at(x-1,y)+3, at(x,y-1)+3, at(x-1,y-1)+4, at(x+1,y-1)+4);
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x; if (!b[i]) continue;
    d[i] = Math.min(d[i], at(x+1,y)+3, at(x,y+1)+3, at(x+1,y+1)+4, at(x-1,y+1)+4);
  }
  for (let i = 0; i < w * h; i++) d[i] /= 3;   // back to ~pixel units
  return d;
}

/* Count nuclei in a blob: distance-transform peaks with non-max suppression
   at the expected cell radius. This is what splits touching cells. */
function peaksIn(px, d, w, h, rExp, band) {
  // A real cell has an inscribed radius close to the expected radius, so a
  // valid peak's distance value must lie in a physical band around rExp.
  // Without this, one lump of debris that survives the classifier is split
  // by the transform into three or four phantom "cells".
  const lo = (band ? band[0] : 0.55) * rExp, hi = (band ? band[1] : 1.8) * rExp;
  const cand = [];
  for (const i of px) {
    const v = d[i]; if (v < lo || v > hi) continue;
    const x = i % w, y = (i / w) | 0;
    let isMax = true;
    for (let dy = -1; dy <= 1 && isMax; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h || (dx === 0 && dy === 0)) continue;
      if (d[yy * w + xx] > v) { isMax = false; break; }
    }
    if (isMax) cand.push({ x, y, v });
  }
  cand.sort((a, b) => b.v - a.v);
  const keep = [];
  // Suppression radius, as a fraction of the expected cell radius. This is a
  // genuine trade-off with no free setting, measured rather than guessed:
  //
  //   rMin   bias @ moderate density   over-count @ 85% clumping
  //   0.78           -2.6 %                  +17.1 %
  //   0.82           -4.3 %                  +14.3 %
  //   0.85           -5.1 %                   +7.1 %
  //   0.92           -6.0 %                   +1.4 %
  //
  // Too small and one cell yields two peaks in a clump; too large and a
  // touching pair collapses into one. 0.85 balances the two across density,
  // clumping, staining and debris. See SPEC.md section 4.
  const rMin = Math.max(2, 0.85 * rExp);
  for (const c of cand) {
    let ok = true;
    for (const k of keep) if (Math.hypot(c.x - k.x, c.y - k.y) < rMin) { ok = false; break; }
    if (ok) keep.push(c);
  }
  return keep;
}

/* Mean blueness in a disc — sampled per detected nucleus, not per blob.
   A live cell touching a dead one forms one blob; labelling the whole blob
   from its mean colour miscalls every mixed doublet. */
function bluenessAt(img, x, y, r) {
  let sR = 0, sB = 0, n = 0;
  const w = img.width, h = img.height;
  for (let yy = Math.max(0, Math.round(y - r)); yy <= Math.min(h - 1, Math.round(y + r)); yy++)
    for (let xx = Math.max(0, Math.round(x - r)); xx <= Math.min(w - 1, Math.round(x + r)); xx++) {
      if (Math.hypot(xx - x, yy - y) > r) continue;
      const j = (yy * w + xx) * 4; sR += img.data[j]; sB += img.data[j+2]; n++;
    }
  return n ? (sB - sR) / (sB + sR + 1) : 0;
}

/* ---------- features ---------- */
function blobFeatures(px, lab, id, g, img, d, w, h, rExp) {
  let minx = 1e9, miny = 1e9, maxx = -1, maxy = -1, sx = 0, sy = 0;
  let perim = 0, sumG = 0, sumB = 0, sumR = 0, dmax = 0, dmx = 0, dmy = 0;
  for (const i of px) {
    const x = i % w, y = (i / w) | 0;
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
    sx += x; sy += y; sumG += g[i];
    const j = i * 4; sumR += img.data[j]; sumB += img.data[j+2];
    if (d[i] > dmax) { dmax = d[i]; dmx = x; dmy = y; }
    // 4-neighbour boundary test
    if (x === 0 || y === 0 || x === w-1 || y === h-1 ||
        lab[i-1] !== id || lab[i+1] !== id || lab[i-w] !== id || lab[i+w] !== id) perim++;
  }
  const area = px.length;
  const bw = maxx - minx + 1, bh = maxy - miny + 1;
  // Refractility: a live cell under bright field has a bright core and a dark
  // rim; debris is solid dark. Size and shape alone cannot separate medium
  // round junk from a cell, but this can.
  let core = 0, nc = 0, rim = 0, nr = 0;
  const rC = 0.45 * rExp, rI = 0.75 * rExp, rO = 1.05 * rExp;
  for (let y = Math.max(0, Math.round(dmy - rO)); y <= Math.min(h - 1, Math.round(dmy + rO)); y++)
    for (let x = Math.max(0, Math.round(dmx - rO)); x <= Math.min(w - 1, Math.round(dmx + rO)); x++) {
      const dd = Math.hypot(x - dmx, y - dmy), i = y * w + x;
      if (dd <= rC) { core += g[i]; nc++; }
      else if (dd >= rI && dd <= rO) { rim += g[i]; nr++; }
    }
  const coreRim = (nc && nr) ? (core / nc - rim / nr) / 128 : 0;
  const expArea = Math.PI * rExp * rExp;
  // background reference: median of the whole field is ~128 after flat-field
  const meanG = sumG / area;
  return {
    area, cx: sx / area, cy: sy / area, minx, miny, maxx, maxy, dmax,
    areaRatio  : area / expArea,
    circularity: Math.min(1.5, 4 * Math.PI * area / (perim * perim || 1)),
    extent     : area / (bw * bh),
    aspect     : Math.max(bw, bh) / Math.max(1, Math.min(bw, bh)),
    dtRatio    : dmax / rExp,
    contrast   : Math.max(0, (128 - meanG) / 128),
    coreRim    : coreRim,
    blueness   : (sumB - sumR) / (sumB + sumR + 1),
    dmx, dmy,
    touchesRB  : (maxx >= w - 2) || (maxy >= h - 2),
    touchesLT  : (minx <= 1) || (miny <= 1),
  };
}
function featureVector(f) { return MODEL.features.map(k => f[k]); }
function pCell(f) {
  const x = featureVector(f);
  let z = MODEL.b;
  for (let i = 0; i < x.length; i++) z += MODEL.w[i] * ((x[i] - MODEL.mu[i]) / MODEL.sigma[i]);
  return 1 / (1 + Math.exp(-z));
}

/* ---------- main ---------- */
function analyze(image, opts) {
  const o = Object.assign({
    umPerPx: 0.5, cellDiaUm: 12, dilution: 1, viability: false,
    blueThreshold: 0.08, analysisWidth: 720, pThreshold: 0.5, edgeRule: true,
    dtBand: [0.55, 1.8],   // valid inscribed radius, as a fraction of expected
    minCellRadiusPx: 10,   // analysis is upscaled if needed to reach this
  }, opts || {});

  // Analysis resolution must be chosen for the CELL, not for the sensor.
  // A live cell is a refractile ring whose rim is a fraction of its radius:
  // downscale until the radius is ~6 px and the rim is barely one pixel, the
  // morphological open erases it, and only the solid dark (dead) cells survive
  // segmentation. The count collapses AND viability reads 0% live — a failure
  // that looks like a stain problem and is really a sampling problem.
  const rAtFull = (o.cellDiaUm / 2) / o.umPerPx;     // expected radius in source px
  const needW = rAtFull > 0 ? Math.ceil(o.minCellRadiusPx * image.width / rAtFull) : 0;
  const aw = Math.min(image.width, Math.max(o.analysisWidth, needW));
  const img = downscale(image, aw);
  const w = img.width, h = img.height;
  const scale = image.width / w;                     // px of original per px analysed
  const umPerPx = o.umPerPx * scale;
  const rExp = (o.cellDiaUm / 2) / umPerPx;          // expected radius, analysis px

  const g0 = toGray(img);
  const g = flatField(g0, w, h);
  const thr = otsu(g);
  let b = threshold(g, w, h, thr);
  // ORDER IS LOad-BEARING: fill holes BEFORE opening.
  // A live cell under bright field thresholds to a ring whose rim is about
  // 0.28 x radius. Opening first erodes any structure thinner than ~3 px, so
  // for cells below ~11 px radius the rim is deleted outright and the cell
  // never becomes a blob. Only the solid dark (dead) cells survive, so the
  // count collapses and viability reads 0% live — which looks like a staining
  // fault and is really an operator-order fault. Filling first turns the ring
  // into a disc, and opening a disc is harmless.
  b = fillHoles(b, w, h);
  b = open(b, w, h);
  const { lab, comps } = labelCC(b, w, h);
  const d = distanceTransform(b, w, h);

  const blobs = [];
  for (let id = 0; id < comps.length; id++) {
    const px = comps[id];
    if (px.length < 8) continue;
    const f = blobFeatures(px, lab, id, g, img, d, w, h, rExp);
    f.p = pCell(f);
    f.isCell = f.p >= o.pThreshold;
    const pk = f.isCell ? peaksIn(px, d, w, h, rExp, o.dtBand) : [];
    // count = number of physically plausible nuclei, NOT "at least one":
    // a blob with no valid peak is not a cell however the classifier scored it
    f.n = f.isCell ? pk.length : 0;
    f.isCell = f.isCell && f.n > 0;
    f.peaks = pk;
    if (o.viability) for (const p of pk) {
      p.blueness = bluenessAt(img, p.x, p.y, 0.6 * rExp);
      p.dead = p.blueness > o.blueThreshold;
    }
    f.dead = o.viability ? (f.blueness > o.blueThreshold) : null;
    // Hemocytometer edge rule: count blobs on the top/left borders, drop
    // bottom/right, so a cell straddling two fields is counted exactly once.
    f.counted = f.isCell && !(o.edgeRule && f.touchesRB);
    blobs.push(f);
  }

  let total = 0, dead = 0, live = 0;
  for (const f of blobs) if (f.counted) {
    total += f.n;
    if (o.viability) for (const p of f.peaks) { if (p.dead) dead++; else live++; }
  }

  const areaMm2 = (w * umPerPx / 1000) * (h * umPerPx / 1000);
  // volume over a chamber of depth 0.1 mm; 1 mL = 1000 mm^3
  const perMl = areaMm2 > 0 ? total * 1e4 / areaMm2 * o.dilution : null;

  return {
    total, live, dead,
    viability: o.viability && total ? 100 * live / total : null,
    concentrationPerMl: perMl,
    areaMm2, umPerPx, rExp, threshold: thr, analysisWidth: w,
    resolutionOk: rExp >= o.minCellRadiusPx - 0.5,
    nBlobs: blobs.length,
    nRejected: blobs.filter(f => !f.isCell).length,
    blobs, width: w, height: h,
  };
}

/* Aggregate several scanned fields into one result. */
function aggregate(fields, dilution) {
  const total = fields.reduce((a, f) => a + f.total, 0);
  const live  = fields.reduce((a, f) => a + f.live, 0);
  const dead  = fields.reduce((a, f) => a + f.dead, 0);
  const area  = fields.reduce((a, f) => a + f.areaMm2, 0);
  const counts = fields.map(f => f.total);
  const mean = counts.length ? total / counts.length : 0;
  const sd = counts.length > 1
    ? Math.sqrt(counts.reduce((a, c) => a + (c - mean) ** 2, 0) / (counts.length - 1)) : 0;
  return {
    nFields: fields.length, total, live, dead, areaMm2: area,
    viability: total ? 100 * live / total : null,
    concentrationPerMl: area > 0 ? total * 1e4 / area * (dilution || 1) : null,
    meanPerField: mean, sdPerField: sd,
    cvPercent: mean > 0 ? 100 * sd / mean : null,
    // Poisson counting precision: the irreducible error from counting N events
    relSePercent: total > 0 ? 100 / Math.sqrt(total) : null,
  };
}

return { analyze, aggregate, setModel, getModel, downscale, toGray, flatField,
         otsu, threshold, open, fillHoles, labelCC, distanceTransform, peaksIn,
         blobFeatures, featureVector, pCell, bluenessAt };
}));
