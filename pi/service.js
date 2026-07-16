#!/usr/bin/env node
/* =====================================================================
   service.js — the whole instrument, headless, on the Pi.

   capture -> autofocus -> count -> store -> stream to any phone on the LAN.

   Runs count-engine.js UNCHANGED, the same file the browser app runs and the
   same file test.js validates. It is deliberately not ported to Python and
   OpenCV: a port is a second implementation, a second implementation drifts,
   and every accuracy claim we have (MAPE 1.54 %, the debris-splitting fix,
   per-nucleus viability) is attached to this code, not to the algorithm in
   the abstract.

   Zero npm dependencies except optional pigpio. Live updates use Server-Sent
   Events rather than WebSockets: SSE is plain HTTP, so there is nothing to
   install, it reconnects by itself, and it survives the Pi's wifi dropping.

     sudo node service.js                 # real hardware
     node service.js --sim                # laptop, no hardware at all
   ===================================================================== */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createStage } = require('./stage.js');
const { createCamera } = require('./camera.js');
const { AutoFocus } = require('./focus.js');
const { planScan, makeStepper } = require('./scan.js');
const Engine = require('../count-engine.js');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : (argv[i+1] ?? true); };
const SIM = argv.includes('--sim');
const PORT = +flag('port', 8000);
const DATA = flag('data', path.join(__dirname, 'data'));
const CLIENT = path.join(__dirname, 'client');

const cfg = {
  umPerPx : +flag('um-per-px', 0.55),
  cellDiaUm: +flag('cell-dia', 12),
  dilution: +flag('dilution', 2),
  depthMm : +flag('depth', 0.1),
  viability: true,
  umPerStep: { X: +flag('um-step', 5), Y: +flag('um-step', 5), Z: +flag('um-step-z', 1) },
  zRange  : [+flag('z-min', 0), +flag('z-max', 120)],
  autofocus: !argv.includes('--no-autofocus'),
};

fs.mkdirSync(DATA, { recursive: true });
const stage = createStage({ sim: SIM, umPerStep: cfg.umPerStep });
const camera = createCamera({ sim: SIM, stage, width: +flag('width', 1280), height: +flag('height', 960) });

let state = {
  busy: false, phase: 'idle', field: 0, nFields: 0,
  focusZ: null, focusOk: null, fields: [], lastError: null,
  pos: { X: 0, Y: 0, Z: 0 },
  stage: stage.kind, camera: camera.kind, sim: SIM,
  model: Engine.getModel().trainedOn,
};

/* ---------------- SSE ---------------- */
const clients = new Set();
function emit(ev, data) {
  const msg = `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) { try { c.write(msg); } catch {} }
}
function pushState(patch) {
  Object.assign(state, patch);
  state.pos = { X: stage.posUm('X'), Y: stage.posUm('Y'), Z: stage.posUm('Z') };
  emit('state', publicState());
}
const publicState = () => ({ ...state, fields: state.fields.map(summary) });
const summary = f => ({ index: f.index, total: f.total, live: f.live, dead: f.dead,
                        rejected: f.nRejected, areaMm2: f.areaMm2, focusZ: f.focusZ,
                        focusOk: f.focusOk, truth: f.truth ?? null });

/* ---------------- focus ---------------- */
const af = new AutoFocus({
  moveTo: async z => { await stage.move('Z', Math.round((z - stage.posUm('Z')) / cfg.umPerStep.Z)); },
  capture: () => camera.capture(),
  metric: 'tenengrad',
  onStep: (z, v) => emit('focus', { z, v }),
});

async function focusField(first) {
  if (!cfg.autofocus) return { ok: true, z: stage.posUm('Z') };
  pushState({ phase: 'focusing' });
  let r;
  if (!first && state.focusZ != null) {
    r = await af.track(state.focusZ, 6);
    // tracking failed => the surface moved more than the window; do it properly
    if (!r.ok) r = await af.search({ zMin: cfg.zRange[0], zMax: cfg.zRange[1] });
  } else {
    r = await af.search({ zMin: cfg.zRange[0], zMax: cfg.zRange[1] });
  }
  pushState({ focusZ: r.z, focusOk: r.ok });
  return r;
}

/* ---------------- counting ---------------- */
async function countHere(index, focusOk, focusZ) {
  pushState({ phase: 'counting' });
  const img = await camera.capture();
  const res = Engine.analyze(img, {
    umPerPx: cfg.umPerPx, cellDiaUm: cfg.cellDiaUm,
    dilution: cfg.dilution, viability: cfg.viability, analysisWidth: 720,
  });
  if (!res.resolutionOk)
    console.warn(`[count] cell radius ${res.rExp.toFixed(1)} px is too small to segment reliably`);
  const rec = { index, total: res.total, live: res.live, dead: res.dead,
                rExp: res.rExp, resolutionOk: res.resolutionOk,
                nRejected: res.nRejected, areaMm2: res.areaMm2,
                focusZ, focusOk, truth: camera.lastTruth ?? null,
                x: stage.posUm('X'), y: stage.posUm('Y') };
  return rec;
}

async function runScan({ gx, gy }) {
  if (state.busy) throw new Error('already scanning');
  state.busy = true;
  const fields = [];
  try {
    const probe = await camera.capture();
    const aw = 720, ah = Math.round(probe.height * aw / probe.width);
    const scale = probe.width / aw;
    const plan = planScan({ gx, gy, fieldW: aw * cfg.umPerPx * scale, fieldH: ah * cfg.umPerPx * scale });
    const stepper = makeStepper(cfg.umPerStep.X);
    pushState({ nFields: plan.stops.length, fields: [], phase: 'scanning', lastError: null });

    for (let i = 0; i < plan.stops.length; i++) {
      if (!state.busy) break;
      if (i > 0) {
        pushState({ phase: 'moving', field: i });
        const m = plan.moves[i - 1];
        const { sx, sy } = stepper.toSteps(m.dx, m.dy);
        if (sx) await stage.move('X', sx);
        if (sy) await stage.move('Y', sy);
        await new Promise(r => setTimeout(r, 250));      // let the stage stop ringing
      }
      if (camera.kind === 'simulator') camera.seed = i + 1;   // a fresh field per stop
      const f = await focusField(i === 0);
      const rec = await countHere(i, f.ok, f.z);
      fields.push(rec);
      state.fields = fields;
      pushState({ field: i + 1 });
      emit('field', summary(rec));
    }

    const agg = Engine.aggregate(fields.map(f => ({ ...f })), cfg.dilution);
    agg.concentrationPerMl *= (0.1 / cfg.depthMm);
    const out = { at: new Date().toISOString(), settings: { ...cfg }, plan: { gx, gy },
                  model: Engine.getModel().trainedOn, aggregate: agg, fields };
    const file = path.join(DATA, `scan-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    pushState({ phase: 'done' });
    emit('result', { ...agg, file: path.basename(file) });
    return out;
  } catch (e) {
    pushState({ phase: 'error', lastError: e.message });
    throw e;
  } finally {
    state.busy = false;
    stage.release();
  }
}

/* ---------------- HTTP ---------------- */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
               '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg' };
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const readBody = req => new Promise(r => {
  let b = ''; req.on('data', c => (b += c)); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } });
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/api/state') return send(res, 200, publicState());

    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
                           Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
      res.write('retry: 2000\n\n');
      res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
      clients.add(res);
      const ka = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
      req.on('close', () => { clearInterval(ka); clients.delete(res); });
      return;
    }

    if (p === '/api/scan' && req.method === 'POST') {
      const b = await readBody(req);
      runScan({ gx: +b.gx || 3, gy: +b.gy || 3 }).catch(e => console.error('[scan]', e.message));
      return send(res, 202, { started: true });
    }
    if (p === '/api/stop' && req.method === 'POST') { state.busy = false; return send(res, 200, { stopped: true }); }

    if (p === '/api/jog' && req.method === 'POST') {
      const b = await readBody(req);
      if (state.busy) return send(res, 409, { error: 'busy' });
      await stage.moveUm(String(b.axis || 'X').toUpperCase(), +b.um || 0);
      pushState({});
      return send(res, 200, { pos: state.pos });
    }
    if (p === '/api/zero' && req.method === 'POST') { stage.zero(); pushState({}); return send(res, 200, { pos: state.pos }); }

    if (p === '/api/focus' && req.method === 'POST') {
      if (state.busy) return send(res, 409, { error: 'busy' });
      state.busy = true;
      try { const r = await focusField(true); return send(res, 200, r); }
      finally { state.busy = false; }
    }

    if (p === '/api/count' && req.method === 'POST') {
      if (state.busy) return send(res, 409, { error: 'busy' });
      state.busy = true;
      try {
        const rec = await countHere(0, state.focusOk, state.focusZ);
        state.fields = [rec]; pushState({ nFields: 1, field: 1, phase: 'done' });
        return send(res, 200, rec);
      } finally { state.busy = false; }
    }

    if (p === '/api/scans') {
      const files = fs.readdirSync(DATA).filter(f => f.endsWith('.json')).sort().reverse();
      return send(res, 200, files.slice(0, 50));
    }
    if (p.startsWith('/api/scan/')) {
      const f = path.join(DATA, path.basename(p.slice('/api/scan/'.length)));
      if (!fs.existsSync(f)) return send(res, 404, { error: 'not found' });
      return send(res, 200, fs.readFileSync(f, 'utf8'));
    }
    if (p === '/api/preview.jpg') {
      try { return send(res, 200, await camera.captureJpeg(640), 'image/jpeg'); }
      catch (e) { return send(res, 503, { error: e.message }); }
    }

    // static client
    let f = path.join(CLIENT, p === '/' ? 'index.html' : p.replace(/^\/+/, ''));
    if (!f.startsWith(CLIENT)) return send(res, 403, { error: 'nope' });
    if (!fs.existsSync(f)) return send(res, 404, 'not found', 'text/plain');
    return send(res, 200, fs.readFileSync(f), MIME[path.extname(f)] || 'application/octet-stream');
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`CellScope service on http://0.0.0.0:${PORT}`);
  console.log(`  stage:  ${stage.kind}   camera: ${camera.kind}${SIM ? '   [SIMULATED]' : ''}`);
  console.log(`  model:  ${Engine.getModel().trainedOn}`);
  console.log(`  data:   ${DATA}`);
});
process.on('SIGINT', () => { try { stage.dispose(); } catch {} process.exit(0); });
