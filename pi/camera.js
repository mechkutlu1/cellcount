/* =====================================================================
   camera.js — Raspberry Pi HQ camera (IMX477) via rpicam-still.

   Captures RAW RGB888 straight to stdout (--encoding rgb) rather than JPEG
   or PNG. Two reasons: no decoder dependency at all, and no JPEG artefacts
   in an image we are about to threshold and measure. A compression artefact
   at a cell rim is indistinguishable from a cell rim.

   With the sensor bolted to a C-mount at the image plane, the calibration is
   fixed per objective forever, which removes the single largest error source
   of the phone-at-the-eyepiece build: nobody can nudge the zoom.
   ===================================================================== */
'use strict';
const { spawn, execSync } = require('child_process');

function detectBinary() {
  for (const b of ['rpicam-still', 'libcamera-still']) {
    try { execSync(`which ${b}`, { stdio: 'ignore' }); return b; } catch {}
  }
  return null;
}

class PiCamera {
  constructor(opts = {}) {
    this.kind = 'rpicam';
    this.width = opts.width || 1280;
    this.height = opts.height || 960;
    this.timeoutMs = opts.timeoutMs || 300;
    this.extra = opts.extra || [];
    this.bin = opts.bin || detectBinary();
    if (!this.bin) throw new Error('no rpicam-still/libcamera-still on PATH');
  }

  capture() {
    return new Promise((resolve, reject) => {
      const args = ['--nopreview', '-t', String(this.timeoutMs),
                    '--width', String(this.width), '--height', String(this.height),
                    '--encoding', 'rgb', '-o', '-', ...this.extra];
      const p = spawn(this.bin, args);
      const chunks = []; let err = '';
      p.stdout.on('data', c => chunks.push(c));
      p.stderr.on('data', c => (err += c));
      p.on('error', reject);
      p.on('close', code => {
        if (code !== 0) return reject(new Error(`${this.bin} exited ${code}: ${err.slice(0, 300)}`));
        const buf = Buffer.concat(chunks);
        const want = this.width * this.height * 3;
        if (buf.length !== want)
          return reject(new Error(
            `expected ${want} raw RGB bytes, got ${buf.length}. The sensor may be padding rows; ` +
            `pick a width that is a multiple of 32, or capture jpg and decode.`));
        const data = new Uint8ClampedArray(this.width * this.height * 4);
        for (let i = 0, j = 0; i < want; i += 3, j += 4) {
          data[j] = buf[i]; data[j+1] = buf[i+1]; data[j+2] = buf[i+2]; data[j+3] = 255;
        }
        resolve({ width: this.width, height: this.height, data });
      });
    });
  }

  /* JPEG for the phone preview only — never for measurement. */
  captureJpeg(width = 640) {
    return new Promise((resolve, reject) => {
      const h = Math.round(width * this.height / this.width);
      const p = spawn(this.bin, ['--nopreview', '-t', String(this.timeoutMs),
                                 '--width', String(width), '--height', String(h),
                                 '--encoding', 'jpg', '-q', '75', '-o', '-', ...this.extra]);
      const chunks = [];
      p.stdout.on('data', c => chunks.push(c));
      p.on('error', reject);
      p.on('close', c => c === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('jpeg capture failed')));
    });
  }
}

/* Simulated camera: renders a synthetic field, defocused according to how far
   the stage's Z is from a pretend focal plane, so the autofocus and the scan
   loop can be exercised end to end with no hardware present. */
class SimCamera {
  constructor(opts = {}) {
    this.kind = 'simulator';
    this.width = opts.width || 720;
    this.height = opts.height || 540;
    this.stage = opts.stage || null;
    this.focusZ = opts.focusZ != null ? opts.focusZ : 60;   // µm
    this.tiltPerMm = opts.tiltPerMm || 12;                  // focal plane tilt across the slide
    this.cellDiaPx = opts.cellDiaPx || 22;
    this.seed = 1;
    this.Synth = require('../synth.js');
  }
  _box(img, R) {
    const { width: w, height: h } = img;
    const out = new Uint8ClampedArray(img.data.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let a = 0, b = 0, c = 0, n = 0;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const xx = Math.min(w-1, Math.max(0, x+dx)), yy = Math.min(h-1, Math.max(0, y+dy));
        const j = (yy*w+xx)*4; a += img.data[j]; b += img.data[j+1]; c += img.data[j+2]; n++;
      }
      const o = (y*w+x)*4;
      out[o] = a/n; out[o+1] = b/n; out[o+2] = c/n; out[o+3] = 255;
    }
    return { width: w, height: h, data: out };
  }
  /* Continuous in radius, by interpolating between integer kernels. Rounding
     the radius to an integer quantises every defocus below ~1 px to the same
     kernel, which flattens the focus curve for a dozen microns either side of
     true focus. The autofocus then has nothing to climb and settles on noise. */
  _blur(img, r) {
    if (r <= 0.02) return img;
    const lo = Math.floor(r), hi = lo + 1, t = r - lo;
    const a = lo < 1 ? img : this._box(img, lo);
    const b = this._box(img, hi);
    const out = new Uint8ClampedArray(a.data.length);
    for (let i = 0; i < a.data.length; i++) out[i] = a.data[i] * (1 - t) + b.data[i] * t;
    return { width: a.width, height: a.height, data: out };
  }
  async capture() {
    const f = this.Synth.makeField({
      seed: this.seed, width: this.width, height: this.height,
      cellDiaPx: this.cellDiaPx, nCells: 45 + (this.seed * 7) % 40,
      deadFrac: 0.2, nDebris: 10, clusterFrac: 0.3, noise: 0 });
    this.lastField = f;
    // truth under the same edge rule the engine applies, so the comparison is fair
    this.lastTruth = f.truth.filter(t =>
      !(t.x + t.r >= this.width - 2 || t.y + t.r >= this.height - 2)).length;
    let img = f.image;
    if (this.stage) {
      const xMm = this.stage.posUm('X') / 1000;
      const plane = this.focusZ + this.tiltPerMm * xMm;    // the slide is never flat
      img = this._blur(img, Math.abs(this.stage.posUm('Z') - plane) / 8);
    }
    // sensor grain is added after the optics, not before
    const d = new Uint8ClampedArray(img.data);
    for (let i = 0; i < d.length; i += 4) {
      const n = (Math.random() * 2 - 1) * 5;
      d[i] += n; d[i+1] += n; d[i+2] += n;
    }
    return { width: img.width, height: img.height, data: d };
  }
  async captureJpeg() { throw new Error('no preview in simulator'); }
}

function createCamera(opts = {}) {
  if (opts.sim) return new SimCamera(opts);
  try { return new PiCamera(opts); }
  catch (e) {
    console.warn('[camera] ' + e.message + ' — running simulated');
    return new SimCamera(opts);
  }
}

module.exports = { createCamera, PiCamera, SimCamera };
