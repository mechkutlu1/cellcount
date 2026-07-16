/* =====================================================================
   focus.js — focus metrics and autofocus search.
   Pure functions plus a search driven by injected moveTo/capture callbacks,
   so the whole thing is testable on synthetic blur stacks with no hardware.
   ===================================================================== */
'use strict';

function toGray(img) {
  const n = img.width * img.height, g = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    g[i] = 0.299 * img.data[j] + 0.587 * img.data[j + 1] + 0.114 * img.data[j + 2];
  }
  return g;
}

/* Tenengrad: Sobel gradient energy. Normalised by mean intensity squared so
   that a dimmer field does not read as a blurrier one — without that, an
   autofocus sweep will happily chase the brightest plane rather than the
   sharpest. */
function tenengrad(img, roi) {
  const g = toGray(img), w = img.width, h = img.height;
  const x0 = roi ? roi.x0 : 1, x1 = roi ? roi.x1 : w - 1;
  const y0 = roi ? roi.y0 : 1, y1 = roi ? roi.y1 : h - 1;
  let sum = 0, mean = 0, n = 0;
  for (let y = Math.max(1, y0); y < Math.min(h - 1, y1); y++)
    for (let x = Math.max(1, x0); x < Math.min(w - 1, x1); x++) {
      const i = y * w + x;
      const gx = -g[i-w-1] - 2*g[i-1] - g[i+w-1] + g[i-w+1] + 2*g[i+1] + g[i+w+1];
      const gy = -g[i-w-1] - 2*g[i-w] - g[i-w+1] + g[i+w-1] + 2*g[i+w] + g[i+w+1];
      sum += gx * gx + gy * gy;
      mean += g[i]; n++;
    }
  if (!n) return 0;
  mean /= n;
  return (sum / n) / (mean * mean + 1);
}

/* Normalised variance: cheaper, less peaky, a useful cross-check. */
function normVariance(img, roi) {
  const g = toGray(img), w = img.width, h = img.height;
  const x0 = roi ? roi.x0 : 0, x1 = roi ? roi.x1 : w;
  const y0 = roi ? roi.y0 : 0, y1 = roi ? roi.y1 : h;
  let s = 0, s2 = 0, n = 0;
  for (let y = Math.max(0, y0); y < Math.min(h, y1); y++)
    for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) {
      const v = g[y * w + x]; s += v; s2 += v * v; n++;
    }
  if (!n) return 0;
  const m = s / n;
  return (s2 / n - m * m) / (m * m + 1);
}

const METRICS = { tenengrad, normVariance };

/* Parabolic interpolation through the peak and its two neighbours: recovers
   sub-step precision without taking more pictures. */
function refinePeak(zs, vs, k) {
  if (k <= 0 || k >= vs.length - 1) return zs[k];
  const a = vs[k - 1], b = vs[k], c = vs[k + 1];
  const den = a - 2 * b + c;
  if (Math.abs(den) < 1e-12) return zs[k];
  let off = 0.5 * (a - c) / den;                       // in index units
  if (!isFinite(off)) return zs[k];
  // If the centre sample is the maximum, the parabola's vertex cannot lie
  // more than half a sample away. Allowing more lets a degenerate fit (two
  // near-equal neighbours) extrapolate to the edge of the window and return
  // a focus that was never measured.
  if (Math.abs(off) > 0.5) off = Math.sign(off) * 0.5;
  const step = (zs[k + 1] - zs[k - 1]) / 2;
  return zs[k] + off * step;
}

class AutoFocus {
  /* moveTo(z) -> Promise, capture() -> Promise<image>, metric name, roi */
  constructor({ moveTo, capture, metric = 'tenengrad', roi = null,
                contrastRatio = 1.6, onStep = null }) {
    this.moveTo = moveTo; this.capture = capture;
    this.metric = METRICS[metric] || tenengrad;
    this.roi = roi; this.contrastRatio = contrastRatio; this.onStep = onStep;
  }

  async profile(zs) {
    const vs = [];
    for (const z of zs) {
      await this.moveTo(z);
      const img = await this.capture();
      const v = this.metric(img, this.roi);
      vs.push(v);
      if (this.onStep) this.onStep(z, v);
    }
    return vs;
  }

  /* Track focus between fields. A full search costs ~14 exposures; the
     specimen surface tilts gradually, so after the first field a few points
     around the last known z recover the new focus for a third of the cost.
     Five points, not three: three can locate a peak or validate that it is
     interior, but not both — a drift of exactly half the span ties two
     samples and lands the maximum on the window edge. On failure the caller
     should fall back to a full search rather than accept a guess. */
  async track(z0, span = 6, points = 5) {
    const zs = [];
    for (let i = 0; i < points; i++) zs.push(z0 - span + 2 * span * i / (points - 1));
    const vs = await this.profile(zs);
    const k = vs.indexOf(Math.max(...vs));
    // peak at an end means focus has walked out of the local window
    if (k === 0 || k === vs.length - 1)
      return { ok: false, reason: 'focus drifted beyond the tracking window', z: zs[k] };
    const z = refinePeak(zs, vs, k);
    await this.moveTo(z);
    return { ok: true, z, value: vs[k] };
  }

  /* Coarse sweep, then a fine sweep around the coarse peak, then parabolic
     interpolation. A plain hill-climb is not used on purpose: bright-field
     focus curves have shoulders, and a hill-climb settles on the first one. */
  async search({ zMin, zMax, coarse = 9, fine = 5 } = {}) {
    const zsC = [];
    for (let i = 0; i < coarse; i++) zsC.push(zMin + (zMax - zMin) * i / (coarse - 1));
    const vsC = await this.profile(zsC);

    const hi = Math.max(...vsC), lo = Math.min(...vsC);
    // A field with nothing in it has a flat curve; focusing on noise is worse
    // than admitting failure, because a confident wrong focus silently
    // depresses every count that follows.
    if (!(hi > 0) || hi / (lo + 1e-9) < this.contrastRatio) {
      return { ok: false, reason: 'no focus contrast (empty or featureless field)',
               z: zsC[vsC.indexOf(hi)], profile: { zs: zsC, vs: vsC }, ratio: hi / (lo + 1e-9) };
    }

    const kC = vsC.indexOf(hi);
    const stepC = (zMax - zMin) / (coarse - 1);
    const fMin = Math.max(zMin, zsC[kC] - stepC), fMax = Math.min(zMax, zsC[kC] + stepC);
    const zsF = [];
    for (let i = 0; i < fine; i++) zsF.push(fMin + (fMax - fMin) * i / (fine - 1));
    const vsF = await this.profile(zsF);
    const kF = vsF.indexOf(Math.max(...vsF));
    const zBest = refinePeak(zsF, vsF, kF);

    await this.moveTo(zBest);
    return { ok: true, z: zBest, value: vsF[kF],
             profile: { zs: zsC.concat(zsF), vs: vsC.concat(vsF) },
             ratio: hi / (lo + 1e-9) };
  }
}

module.exports = { tenengrad, normVariance, METRICS, AutoFocus, refinePeak, toGray };
