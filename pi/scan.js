/* =====================================================================
   scan.js — scan geometry. Pure functions, no hardware, no I/O.
   The whole point is that "did we cover the sample without counting a cell
   twice" is a maths question, answerable in a test rather than by staring
   at a stage.
   ===================================================================== */
'use strict';

/* Field size on the specimen, in micrometres, from the calibration. */
function fieldUm({ widthPx, heightPx, umPerPx }) {
  return { w: widthPx * umPerPx, h: heightPx * umPerPx };
}

/* Serpentine order: boustrophedon. Chosen because it never traverses the
   whole row to get back to the start, which halves the travel and, more
   importantly, halves the number of direction reversals — every reversal is
   where a leadscrew gives back its backlash. */
function planScan({ gx, gy, fieldW, fieldH, overlap = 0 }) {
  if (gx < 1 || gy < 1) throw new Error('grid must be at least 1x1');
  if (overlap < 0 || overlap >= 1) throw new Error('overlap must be in [0,1)');
  const dx = fieldW * (1 - overlap), dy = fieldH * (1 - overlap);
  const stops = [];
  for (let iy = 0; iy < gy; iy++) {
    const rev = iy % 2 === 1;
    for (let k = 0; k < gx; k++) {
      const ix = rev ? gx - 1 - k : k;
      stops.push({ index: stops.length, ix, iy, x: ix * dx, y: iy * dy });
    }
  }
  // relative moves between consecutive stops
  const moves = [];
  for (let i = 1; i < stops.length; i++)
    moves.push({ dx: stops[i].x - stops[i-1].x, dy: stops[i].y - stops[i-1].y });
  return { stops, moves, dx, dy, fieldW, fieldH,
           totalAreaMm2: gx * gy * (fieldW / 1000) * (fieldH / 1000) };
}

/* Do the fields tile the region without gaps or double coverage?
   With overlap=0 and the edge rule (right/bottom blobs dropped, top/left
   kept), adjacent fields abut exactly and every cell is counted once. */
function checkCoverage(plan) {
  const gaps = Math.abs(plan.dx - plan.fieldW) > 1e-9 || Math.abs(plan.dy - plan.fieldH) > 1e-9;
  const seen = new Set();
  let dup = false;
  for (const s of plan.stops) {
    const k = `${s.ix},${s.iy}`;
    if (seen.has(k)) dup = true;
    seen.add(k);
  }
  return { tilesExactly: !gaps, duplicateStops: dup, uniqueStops: seen.size };
}

/* Convert micrometre moves to signed motor steps, carrying the rounding
   remainder forward. Rounding each move independently loses up to half a
   step every field; over a 6x6 scan that is a real, cumulative position
   error that shows up as drift across the sample. */
function makeStepper(umPerStep) {
  let residX = 0, residY = 0;
  return {
    toSteps(dxUm, dyUm) {
      const rx = dxUm / umPerStep + residX, ry = dyUm / umPerStep + residY;
      const sx = Math.round(rx), sy = Math.round(ry);
      residX = rx - sx; residY = ry - sy;
      return { sx, sy };
    },
    residual() { return { x: residX, y: residY }; },
    reset() { residX = residY = 0; },
  };
}

module.exports = { fieldUm, planScan, checkCoverage, makeStepper };
