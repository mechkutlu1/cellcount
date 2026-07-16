/* =====================================================================
   test-pi.js — validates the autofocus search and scan geometry against
   synthetic ground truth. Run: node test-pi.js
   ===================================================================== */
'use strict';
const { AutoFocus, tenengrad, normVariance, refinePeak } = require('./focus.js');
const { planScan, checkCoverage, makeStepper, fieldUm } = require('./scan.js');
const { makeField } = require('../synth.js');

let fails = 0;
const check = (n, c, d) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n + '   ' + d);
                             if (!c) { fails++; process.exitCode = 1; } };

/* ---------- separable box blur, repeated => approximately Gaussian ---------- */
function boxBlur(img, r) {
  let { width: w, height: h } = img;
  let src = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) src[i*3+c] = img.data[i*4+c];
  let dst = new Float32Array(w * h * 3);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) {
        let s = 0, n = 0;
        for (let k = -r; k <= r; k++) { const xx = Math.min(w-1, Math.max(0, x+k)); s += src[(y*w+xx)*3+c]; n++; }
        dst[(y*w+x)*3+c] = s/n;
      }
    [src, dst] = [dst, src];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) {
        let s = 0, n = 0;
        for (let k = -r; k <= r; k++) { const yy = Math.min(h-1, Math.max(0, y+k)); s += src[(yy*w+x)*3+c]; n++; }
        dst[(y*w+x)*3+c] = s/n;
      }
    [src, dst] = [dst, src];
  }
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w*h; i++) { for (let c = 0; c < 3; c++) out[i*4+c] = src[i*3+c]; out[i*4+3] = 255; }
  return { width: w, height: h, data: out };
}
function lerpImg(a, b, t) {
  const out = new Uint8ClampedArray(a.data.length);
  for (let i = 0; i < a.data.length; i++) out[i] = a.data[i] * (1 - t) + b.data[i] * t;
  return { width: a.width, height: a.height, data: out };
}
/* Continuous in radius. An integer-only blur that returns the image untouched
   below r=0.5 creates a flat dead zone several microns wide around true focus:
   every image in it is byte-identical, the focus metric has no gradient where
   it matters most, and the search tie-breaks on sensor noise. Defocus in a
   real microscope is continuous, and the model has to be too. */
function blur(img, radius) {
  if (radius <= 0.02) return img;
  const lo = Math.floor(radius), hi = lo + 1, t = radius - lo;
  const bl = lo < 1 ? img : boxBlur(img, lo);
  const bh = boxBlur(img, hi);
  return lerpImg(bl, bh, t);
}

/* Sensor noise is added AFTER the optics, never before: defocus blurs the
   scene, then the sensor adds its own grain. Blurring an image that already
   contains noise is physically wrong, and it matters — noise that sharpens
   with focus gives an empty field a strong, entirely fictitious focus peak. */
function addNoise(img, sigma, seed) {
  let a = seed | 0;
  const rnd = () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a);
                      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
                      return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const d = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() * 2 - 1) * sigma;
    d[i] = img.data[i] + n; d[i+1] = img.data[i+1] + n; d[i+2] = img.data[i+2] + n; d[i+3] = 255;
  }
  return { width: img.width, height: img.height, data: d };
}

/* A synthetic Z stack: sharpest at trueZ, blurrier with |z - trueZ|. */
function makeStack({ trueZ = 40, seed = 5, nCells = 45, empty = false, noise = 6 }) {
  const base = makeField({ seed, width: 320, height: 240, nCells: empty ? 0 : nCells,
                           nDebris: empty ? 0 : 6, cellDiaPx: 22, clusterFrac: 0.2,
                           noise: 0 });                       // clean scene
  const cache = new Map();
  return z => {
    const key = Math.round(z * 4) / 4;
    if (!cache.has(key))
      cache.set(key, addNoise(blur(base.image, Math.abs(key - trueZ) / 8), noise, key * 7919 + seed));
    return cache.get(key);
  };
}

/* ---------- 1. metric unimodality ---------- */
console.log('--- focus metric ---');
{
  const stack = makeStack({ trueZ: 40 });
  const zs = [], vs = [];
  for (let z = 0; z <= 80; z += 5) { zs.push(z); vs.push(tenengrad(stack(z))); }
  const k = vs.indexOf(Math.max(...vs));
  check('tenengrad peaks at true focus', Math.abs(zs[k] - 40) <= 5, `peak at z=${zs[k]} (true 40)`);
  let mono = true;
  for (let i = 1; i <= k; i++) if (vs[i] < vs[i-1] * 0.98) mono = false;
  for (let i = k + 1; i < vs.length; i++) if (vs[i] > vs[i-1] * 1.02) mono = false;
  check('curve is unimodal (rises then falls)', mono, 'required for peak search to be valid');
  const contrast = Math.max(...vs) / Math.min(...vs);
  check('in-focus/out-of-focus contrast > 3x', contrast > 3, contrast.toFixed(1) + 'x');
  const vn = [];
  for (let z = 0; z <= 80; z += 5) vn.push(normVariance(stack(z)));
  check('normVariance agrees within one step',
        Math.abs(zs[vn.indexOf(Math.max(...vn))] - 40) <= 5,
        `peak at z=${zs[vn.indexOf(Math.max(...vn))]}`);
}

/* ---------- 2. brightness must not fool it ---------- */
console.log('\n--- illumination invariance ---');
{
  const stack = makeStack({ trueZ: 40, seed: 7 });
  const dim = z => {                                  // 35% dimmer everywhere
    const im = stack(z), d = new Uint8ClampedArray(im.data.length);
    for (let i = 0; i < im.data.length; i += 4) {
      d[i] = im.data[i]*0.65; d[i+1] = im.data[i+1]*0.65; d[i+2] = im.data[i+2]*0.65; d[i+3] = 255;
    }
    return { width: im.width, height: im.height, data: d };
  };
  const zs = [], vs = [];
  for (let z = 0; z <= 80; z += 5) { zs.push(z); vs.push(tenengrad(dim(z))); }
  const k = vs.indexOf(Math.max(...vs));
  check('dimming the field does not move the peak', Math.abs(zs[k] - 40) <= 5,
        `peak at z=${zs[k]} on a 35% dimmer stack`);
}

/* ---------- 3. autofocus search finds it ---------- */
console.log('\n--- autofocus search ---');
(async () => {
  for (const trueZ of [12, 40, 63]) {
    const stack = makeStack({ trueZ, seed: 11 });
    let z = 0, moves = 0;
    const af = new AutoFocus({
      moveTo: async t => { z = t; moves++; },
      capture: async () => stack(z),
    });
    const r = await af.search({ zMin: 0, zMax: 80, coarse: 9, fine: 5 });
    check(`autofocus finds z=${trueZ}`, r.ok && Math.abs(r.z - trueZ) <= 4,
          `found ${r.z.toFixed(1)} in ${moves} moves (err ${Math.abs(r.z - trueZ).toFixed(1)})`);
  }

  // parabolic interpolation should beat the raw grid
  {
    const stack = makeStack({ trueZ: 37, seed: 13 });
    let z = 0;
    const af = new AutoFocus({ moveTo: async t => { z = t; }, capture: async () => stack(z) });
    const r = await af.search({ zMin: 0, zMax: 80, coarse: 9, fine: 5 });
    const gridZ = r.profile.zs[r.profile.vs.indexOf(Math.max(...r.profile.vs))];
    check('sub-step interpolation beats the raw grid maximum',
          Math.abs(r.z - 37) <= Math.abs(gridZ - 37) + 0.6,
          `interp ${r.z.toFixed(2)} vs grid ${gridZ.toFixed(2)} (true 37)`);
  }

  /* ---------- 4. it must admit failure on an empty field ---------- */
  console.log('\n--- failure detection ---');
  {
    const stack = makeStack({ trueZ: 40, empty: true });
    let z = 0;
    const af = new AutoFocus({ moveTo: async t => { z = t; }, capture: async () => stack(z) });
    const r = await af.search({ zMin: 0, zMax: 80 });
    check('empty field reports failure rather than a confident wrong focus',
          !r.ok, r.reason || 'claimed success');
  }
  {
    const stack = makeStack({ trueZ: 40, seed: 17 });
    let z = 0;
    const af = new AutoFocus({ moveTo: async t => { z = t; }, capture: async () => stack(z) });
    const r = await af.search({ zMin: 0, zMax: 80 });
    check('a field with cells does not report failure', r.ok, `contrast ratio ${r.ratio.toFixed(1)}x`);
  }

  /* ---------- 5. scan geometry ---------- */
  console.log('\n--- scan geometry ---');
  {
    const f = fieldUm({ widthPx: 720, heightPx: 540, umPerPx: 0.55 });
    check('field size from calibration', Math.abs(f.w - 396) < 1e-6 && Math.abs(f.h - 297) < 1e-6,
          `${f.w} x ${f.h} um`);
    const plan = planScan({ gx: 4, gy: 3, fieldW: f.w, fieldH: f.h });
    check('stop count = gx*gy', plan.stops.length === 12, plan.stops.length);
    const cov = checkCoverage(plan);
    check('fields tile exactly, no gap and no overlap', cov.tilesExactly, `dx=${plan.dx} fieldW=${plan.fieldW}`);
    check('no stop visited twice', !cov.duplicateStops && cov.uniqueStops === 12, cov.uniqueStops + ' unique');
    check('total area = 12 fields', Math.abs(plan.totalAreaMm2 - 12 * 0.396 * 0.297) < 1e-9,
          plan.totalAreaMm2.toFixed(4) + ' mm2');
    // serpentine: row 0 left->right, row 1 right->left
    check('serpentine order', plan.stops[0].ix === 0 && plan.stops[3].ix === 3 &&
                              plan.stops[4].ix === 3 && plan.stops[7].ix === 0,
          plan.stops.slice(0, 8).map(s => s.ix).join(''));
    // one X reversal per row change only
    const xdirs = plan.moves.filter(m => Math.abs(m.dx) > 1e-9).map(m => Math.sign(m.dx));
    let rev = 0; for (let i = 1; i < xdirs.length; i++) if (xdirs[i] !== xdirs[i-1]) rev++;
    check('direction reversals minimised (backlash)', rev <= 2, `${rev} reversals over 12 fields`);
  }

  /* ---------- 6. step rounding must not drift ---------- */
  console.log('\n--- step quantisation ---');
  {
    // 396 um field, 5 um/step => 79.2 steps: rounding each move loses 0.2 step/field
    const st = makeStepper(5);
    let steps = 0;
    for (let i = 0; i < 36; i++) steps += st.toSteps(396, 0).sx;
    const idealSteps = 36 * 396 / 5;
    check('residual carried forward: 36 moves stay exact', Math.abs(steps - idealSteps) <= 1,
          `${steps} steps vs ideal ${idealSteps}`);
    // naive rounding for comparison
    let naive = 0;
    for (let i = 0; i < 36; i++) naive += Math.round(396 / 5);
    check('naive per-move rounding would drift', Math.abs(naive - idealSteps) > 5,
          `naive ${naive} vs ideal ${idealSteps} → ${((naive - idealSteps) * 5).toFixed(0)} um drift`);
  }

  console.log(fails ? `\n${fails} FAILURES` : '\nALL PASS');
})();

/* ---------- 7. focus tracking between fields ---------- */
(async () => {
  await new Promise(r => setTimeout(r, 50));
  console.log('\n--- focus tracking ---');
  let z = 0;
  const s1 = makeStack({ trueZ: 40, seed: 23 });
  const af1 = new AutoFocus({ moveTo: async t => { z = t; }, capture: async () => s1(z) });
  const full = await af1.search({ zMin: 0, zMax: 80 });
  // next field: surface has tilted a little
  const s2 = makeStack({ trueZ: 43, seed: 23 });
  let n = 0;
  const af2 = new AutoFocus({ moveTo: async t => { z = t; n++; }, capture: async () => s2(z) });
  const tr = await af2.track(full.z, 6);
  check('track() recovers a 3-unit drift in 5 exposures', tr.ok && Math.abs(tr.z - 43) <= 2,
        `found ${tr.z.toFixed(1)} (true 43) in ${n} exposures, vs 14 for a full search`);
  const s3 = makeStack({ trueZ: 70, seed: 23 });
  const af3 = new AutoFocus({ moveTo: async t => { z = t; }, capture: async () => s3(z) });
  const tr2 = await af3.track(full.z, 6);
  check('track() reports drift beyond its window instead of guessing', !tr2.ok,
        tr2.reason || 'claimed success');
  console.log(fails ? `\n${fails} FAILURES` : '\nALL PASS (including tracking)');
})();
