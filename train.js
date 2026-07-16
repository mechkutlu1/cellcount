/* =====================================================================
   train.js — fits the cell/debris logistic regression.
   Run:  node train.js
   Writes the MODEL block back into count-engine.js.

   Training and inference deliberately share the same feature extraction
   code (count-engine.js), so a feature computed here is byte-for-byte the
   feature computed on the phone. Re-implementing features in Python would
   invite exactly the drift this avoids.
   ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('./count-engine.js');
const { makeField } = require('./synth.js');

const FEATURES = ['areaRatio','circularity','extent','aspect','dtRatio','contrast','blueness'];

/* Re-derive blobs from a field and label each by proximity to ground truth. */
function labelledBlobs(field) {
  const img = field.image, w = img.width, h = img.height;
  const rExp = field.opts.cellDiaPx / 2;
  const g = E.flatField(E.toGray(img), w, h);
  const thr = E.otsu(g);
  let b = E.threshold(g, w, h, thr);
  b = E.open(b, w, h);
  b = E.fillHoles(b, w, h);
  const { lab, comps } = E.labelCC(b, w, h);
  const d = E.distanceTransform(b, w, h);
  const rows = [];
  for (let id = 0; id < comps.length; id++) {
    const px = comps[id];
    if (px.length < 8) continue;
    const f = E.blobFeatures(px, lab, id, g, img, d, w, h, rExp);
    // a blob is a cell if any true cell centre lies inside it
    let isCell = 0;
    for (const t of field.truth)
      if (Math.hypot(t.x - f.cx, t.y - f.cy) < Math.max(t.r, rExp) * 1.6) { isCell = 1; break; }
    // ...unless a debris centre explains it better
    if (isCell) {
      let dCell = Infinity, dJunk = Infinity;
      for (const t of field.truth) dCell = Math.min(dCell, Math.hypot(t.x - f.cx, t.y - f.cy));
      for (const t of field.debris) dJunk = Math.min(dJunk, Math.hypot(t.x - f.cx, t.y - f.cy));
      if (dJunk < dCell * 0.5) isCell = 0;
    }
    rows.push({ x: FEATURES.map(k => f[k]), y: isCell });
  }
  return rows;
}

function build(seeds, opts) {
  let rows = [];
  for (const s of seeds) rows = rows.concat(labelledBlobs(makeField(Object.assign({ seed: s }, opts))));
  return rows;
}

function standardise(rows) {
  const n = FEATURES.length, mu = Array(n).fill(0), sd = Array(n).fill(0);
  for (const r of rows) for (let i = 0; i < n; i++) mu[i] += r.x[i];
  for (let i = 0; i < n; i++) mu[i] /= rows.length;
  for (const r of rows) for (let i = 0; i < n; i++) sd[i] += (r.x[i] - mu[i]) ** 2;
  for (let i = 0; i < n; i++) sd[i] = Math.sqrt(sd[i] / rows.length) || 1;
  return { mu, sd };
}

function fit(rows, mu, sd, { epochs = 4000, lr = 0.15, l2 = 1e-3 } = {}) {
  const n = FEATURES.length;
  let w = Array(n).fill(0), b = 0;
  const X = rows.map(r => r.x.map((v, i) => (v - mu[i]) / sd[i]));
  const Y = rows.map(r => r.y);
  for (let ep = 0; ep < epochs; ep++) {
    const gw = Array(n).fill(0); let gb = 0;
    for (let k = 0; k < X.length; k++) {
      let z = b; for (let i = 0; i < n; i++) z += w[i] * X[k][i];
      const p = 1 / (1 + Math.exp(-z)), e = p - Y[k];
      for (let i = 0; i < n; i++) gw[i] += e * X[k][i];
      gb += e;
    }
    for (let i = 0; i < n; i++) w[i] -= lr * (gw[i] / X.length + l2 * w[i]);
    b -= lr * gb / X.length;
  }
  return { w, b };
}

function evaluate(rows, model) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const r of rows) {
    let z = model.b;
    for (let i = 0; i < FEATURES.length; i++)
      z += model.w[i] * ((r.x[i] - model.mu[i]) / model.sigma[i]);
    const p = 1 / (1 + Math.exp(-z)) >= 0.5 ? 1 : 0;
    if (p && r.y) tp++; else if (p && !r.y) fp++; else if (!p && !r.y) tn++; else fn++;
  }
  return { tp, fp, tn, fn, acc: (tp + tn) / rows.length,
           prec: tp / (tp + fp || 1), rec: tp / (tp + fn || 1) };
}

/* ---- run ---- */
const TRAIN_SEEDS = Array.from({ length: 14 }, (_, i) => 100 + i);
const VAL_SEEDS   = Array.from({ length: 6 },  (_, i) => 900 + i);
const cfg = { nCells: 55, nDebris: 16, clusterFrac: 0.3, deadFrac: 0.25 };

console.log('generating training fields…');
const train = build(TRAIN_SEEDS, cfg);
const val   = build(VAL_SEEDS, cfg);
console.log(`train blobs: ${train.length} (cells ${train.filter(r => r.y).length})`);
console.log(`val   blobs: ${val.length} (cells ${val.filter(r => r.y).length})`);

const { mu, sd } = standardise(train);
const { w, b } = fit(train, mu, sd);
const model = { features: FEATURES, mu, sigma: sd, w, b,
                trainedOn: `synthetic: ${TRAIN_SEEDS.length} fields, ${train.length} blobs, ${new Date().toISOString().slice(0,10)}` };

console.log('\nweights (standardised):');
FEATURES.forEach((f, i) => console.log(`  ${f.padEnd(12)} ${w[i].toFixed(3)}`));
console.log(`  ${'bias'.padEnd(12)} ${b.toFixed(3)}`);
console.log('\ntrain', evaluate(train, model));
console.log('val  ', evaluate(val, model));

const src = fs.readFileSync(path.join(__dirname, 'count-engine.js'), 'utf8');
const block = `let MODEL = ${JSON.stringify(model, (k, v) =>
  typeof v === 'number' ? +v.toFixed(6) : v, 2)};`;
const out = src.replace(/let MODEL = \{[\s\S]*?\n\};/, block);
if (out === src) { console.error('\nFAILED to splice MODEL into count-engine.js'); process.exit(1); }
fs.writeFileSync(path.join(__dirname, 'count-engine.js'), out);
console.log('\nmodel written into count-engine.js');
