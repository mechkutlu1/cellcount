/* =====================================================================
   CellCount — app layer. The counting itself lives in count-engine.js,
   which is unit-tested headlessly; nothing here changes a count.
   ===================================================================== */
const $ = s => document.querySelector(s);
const E = window.CountEngine, S = window.Synth;

/* ---------------- tabs ---------------- */
const tabs = document.querySelectorAll('nav [role=tab]');
tabs.forEach(b => b.addEventListener('click', () => {
  tabs.forEach(x => x.setAttribute('aria-selected', x === b));
  ['scan','result','setup','method'].forEach(id => $('#tab-' + id).hidden = (b.dataset.tab !== id));
}));
$('#prov').textContent = 'model provenance — ' + E.getModel().trainedOn;

/* ---------------- config ---------------- */
const cfg = () => ({
  umPerPx : +$('#umpx').value,
  cellDiaUm: +$('#dia').value,
  dilution: +$('#dil').value,
  depthMm : +$('#depth').value,
  viability: $('#viab').checked,
  umStep  : +$('#umstep').value,
  gx: +$('#gx').value, gy: +$('#gy').value,
});

/* ---------------- stage transports ---------------- */
/* One interface, three backends. The simulator is not a toy: it is how you
   check the scan logic without risking a sample or a stage crash. */
const NUS = { svc: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
              rx : '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
              tx : '6e400003-b5a3-f393-e0a9-e50e24dcca9e' };
const HM10 = { svc: 0xffe0, rx: 0xffe1, tx: 0xffe1 };

class SimStage {
  constructor() { this.x = 0; this.y = 0; this.name = 'simulator'; }
  async connect() { return true; }
  async send(cmd) {
    const m = /^G ([XY]) (-?\d+)/.exec(cmd);
    if (m) {
      await new Promise(r => setTimeout(r, 120));       // pretend the motor takes time
      if (m[1] === 'X') this.x += +m[2]; else this.y += +m[2];
    }
    if (cmd === 'Z') { this.x = 0; this.y = 0; }
    return 'OK';
  }
}

class BleStage {
  constructor() { this.name = 'bluetooth'; this.queue = []; }
  async connect() {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth unavailable (Android Chrome only)');
    const dev = await navigator.bluetooth.requestDevice({
      filters: [{ services: [NUS.svc] }, { services: [HM10.svc] },
                { namePrefix: 'CellScope' }, { namePrefix: 'HMSoft' }],
      optionalServices: [NUS.svc, HM10.svc],
    });
    const srv = await dev.gatt.connect();
    let s, prof;
    try { s = await srv.getPrimaryService(NUS.svc); prof = NUS; }
    catch { s = await srv.getPrimaryService(HM10.svc); prof = HM10; }
    this.rx = await s.getCharacteristic(prof.rx);
    this.tx = await s.getCharacteristic(prof.tx);
    await this.tx.startNotifications();
    this.buf = '';
    this.tx.addEventListener('characteristicvaluechanged', e => {
      this.buf += new TextDecoder().decode(e.target.value);
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
        const w = this.queue.shift(); if (w) w(line);
      }
    });
    dev.addEventListener('gattserverdisconnected', () => setLink(null));
    this.dev = dev;
    return true;
  }
  async send(cmd) {
    // BLE characteristic writes cap at 20 bytes on most modules; commands are short by design
    await this.rx.writeValue(new TextEncoder().encode(cmd + '\n'));
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('stage timeout')), 8000);
      this.queue.push(v => { clearTimeout(t); res(v); });
    });
  }
}

class WsStage {
  constructor(url) { this.url = url; this.name = 'websocket'; this.queue = []; }
  async connect() {
    if (location.protocol === 'https:' && this.url.startsWith('ws://'))
      throw new Error('Blocked: an https page cannot open ws://. Serve the app from the Pi over http.');
    return new Promise((res, rej) => {
      this.s = new WebSocket(this.url);
      this.s.onopen = () => res(true);
      this.s.onerror = () => rej(new Error('WebSocket failed — is bridge.py running?'));
      this.s.onclose = () => setLink(null);
      this.s.onmessage = e => { const w = this.queue.shift(); if (w) w(String(e.data).trim()); };
    });
  }
  async send(cmd) {
    this.s.send(cmd + '\n');
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('stage timeout')), 8000);
      this.queue.push(v => { clearTimeout(t); res(v); });
    });
  }
}

let stage = null, stagePos = { x: 0, y: 0 };
function setLink(s) {
  stage = s;
  $('#link').textContent = 'stage: ' + (s ? s.name : 'none');
  $('#link').classList.toggle('on', !!s);
  $('#btn-scan').disabled = !(s && (camOn || demo));
}
$('#btn-link').addEventListener('click', async () => {
  const t = $('#transport').value;
  try {
    const s = t === 'sim' ? new SimStage() : t === 'ble' ? new BleStage() : new WsStage($('#wshost').value);
    await s.connect();
    setLink(s);
    $('#btn-link').textContent = 'Connected ✓'; $('#btn-link').classList.add('on');
  } catch (e) {
    alert('Stage connection failed: ' + e.message);
    setLink(null);
  }
});

/* ---------------- jog ---------------- */
const stepsFor = um => Math.round(um / cfg().umStep);
async function jog(axis, um) {
  if (!stage) return alert('Connect a stage first (Setup tab).');
  await stage.send(`G ${axis} ${stepsFor(um)}`);
  stagePos[axis.toLowerCase()] += um;
  $('#pos').textContent = `X${Math.round(stagePos.x)} Y${Math.round(stagePos.y)}`;
}
$('#j-xp').addEventListener('click', () => jog('X',  +$('#jogum').textContent));
$('#j-xm').addEventListener('click', () => jog('X',  -$('#jogum').textContent));
$('#j-yp').addEventListener('click', () => jog('Y',  +$('#jogum').textContent));
$('#j-ym').addEventListener('click', () => jog('Y',  -$('#jogum').textContent));
$('#j-zero').addEventListener('click', async () => {
  if (!stage) return; await stage.send('Z');
  stagePos = { x: 0, y: 0 }; $('#pos').textContent = 'X0 Y0';
});

/* ---------------- camera ---------------- */
let camOn = false, demo = false, demoSeed = 1;
const video = $('#cam'), overlay = $('#overlay');
$('#btn-cam').addEventListener('click', async () => {
  try {
    const st = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false });
    video.srcObject = st; await video.play();
    camOn = true; demo = false;
    $('#tag').textContent = 'camera live';
    $('#btn-count').disabled = false; $('#btn-scan').disabled = !stage;
  } catch (e) { $('#tag').textContent = 'camera unavailable — use Demo'; }
});
$('#btn-demo').addEventListener('click', () => {
  demo = !demo; $('#btn-demo').classList.toggle('on', demo);
  $('#tag').textContent = demo ? 'demo (synthetic)' : (camOn ? 'camera live' : 'camera off');
  $('#btn-count').disabled = !demo && !camOn;
  $('#btn-scan').disabled = !(stage && (demo || camOn));
  if (demo) drawFrame(demoField().image);
});

function demoField() {
  const c = cfg();
  // synthetic field whose cell size matches the current calibration
  const diaPx = c.cellDiaUm / c.umPerPx;
  return S.makeField({ seed: demoSeed, width: 720, height: 540, cellDiaPx: diaPx,
    nCells: 40 + Math.floor(Math.random() * 60), deadFrac: c.viability ? 0.2 : 0,
    nDebris: 12, clusterFrac: 0.3 });
}

function grabImage() {
  if (demo) { const f = demoField(); lastTruth = f.truth.length; return f.image; }
  lastTruth = null;
  const c = document.createElement('canvas');
  c.width = video.videoWidth; c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  return c.getContext('2d').getImageData(0, 0, c.width, c.height);
}
let lastTruth = null;

function drawFrame(img) {
  const c = overlay; c.width = img.width; c.height = img.height;
  c.getContext('2d').putImageData(
    img instanceof ImageData ? img : new ImageData(img.data, img.width, img.height), 0, 0);
}

/* ---------------- overlay of detections ---------------- */
function drawResult(img, res) {
  const c = overlay, g = c.getContext('2d');
  c.width = res.width; c.height = res.height;
  const small = E.downscale(img, res.width);
  g.putImageData(new ImageData(small.data, small.width, small.height), 0, 0);
  const r = Math.max(3, res.rExp * 0.9);
  for (const b of res.blobs) {
    if (!b.isCell) {                              // rejected debris
      g.strokeStyle = 'rgba(107,118,132,.75)'; g.lineWidth = 1;
      g.setLineDash([3, 3]);
      g.strokeRect(b.minx, b.miny, b.maxx - b.minx, b.maxy - b.miny);
      g.setLineDash([]);
      continue;
    }
    for (const p of b.peaks) {
      const dead = p.dead;
      g.strokeStyle = !b.counted ? 'rgba(139,152,165,.8)' : dead ? '#5b8def' : '#3fb98f';
      g.lineWidth = 2;
      g.beginPath(); g.arc(p.x, p.y, r, 0, 7); g.stroke();
    }
  }
}

/* ---------------- counting ---------------- */
let fields = [];
function opts() {
  const c = cfg();
  return { umPerPx: c.umPerPx, cellDiaUm: c.cellDiaUm, dilution: c.dilution,
           viability: c.viability, analysisWidth: 720 };
}
function countOnce() {
  const img = grabImage();
  const res = E.analyze(img, opts());
  drawResult(img, res);
  $('#v-field').textContent = res.total;
  $('#v-live').textContent = cfg().viability ? res.live : '—';
  $('#v-dead').textContent = cfg().viability ? res.dead : '—';
  $('#v-junk').textContent = res.nRejected;
  if (lastTruth != null) res.truth = lastTruth;
  return res;
}
$('#btn-count').addEventListener('click', () => {
  demoSeed++;
  fields = [countOnce()];
  renderResult();
  tabs[1].click();
});

/* ---------------- scan ---------------- */
let scanning = false;
function buildMap(gx, gy, done, cur) {
  const m = $('#map');
  m.style.gridTemplateColumns = `repeat(${gx}, 1fr)`;
  m.innerHTML = '';
  for (let i = 0; i < gx * gy; i++) {
    const d = document.createElement('div');
    d.className = 'fld' + (i < done ? ' done' : '') + (i === cur ? ' cur' : '');
    d.textContent = i < done ? (fields[i] ? fields[i].total : '') : '';
    m.appendChild(d);
  }
}
buildMap(3, 3, 0, -1);
$('#gx').addEventListener('input', () => buildMap(cfg().gx, cfg().gy, 0, -1));
$('#gy').addEventListener('input', () => buildMap(cfg().gx, cfg().gy, 0, -1));

$('#btn-scan').addEventListener('click', async () => {
  if (scanning) { scanning = false; return; }
  if (!stage) return alert('Connect a stage first.');
  const c = cfg();
  scanning = true;
  $('#btn-scan').textContent = 'Stop'; $('#btn-scan').classList.add('stop');
  fields = [];
  // step exactly one field width so adjacent fields never overlap; combined
  // with the edge rule, no cell is counted twice and none falls in a gap
  const probe = grabImage();
  const aw = 720, ah = Math.round(probe.height * aw / probe.width);
  const scale = probe.width / aw;
  const fieldUmX = aw * c.umPerPx * scale, fieldUmY = ah * c.umPerPx * scale;
  try {
    for (let iy = 0; iy < c.gy && scanning; iy++) {
      for (let ix = 0; ix < c.gx && scanning; ix++) {
        const idx = iy * c.gx + ix;
        buildMap(c.gx, c.gy, fields.length, idx);
        $('#mapmeta').textContent = `field ${idx + 1}/${c.gx * c.gy}`;
        await new Promise(r => setTimeout(r, 350));   // settle after the move
        demoSeed++;
        fields.push(countOnce());
        buildMap(c.gx, c.gy, fields.length, idx);
        if (ix < c.gx - 1) await jog('X', (iy % 2 === 0 ? 1 : -1) * fieldUmX);  // serpentine
      }
      if (iy < c.gy - 1) await jog('Y', fieldUmY);
    }
    $('#mapmeta').textContent = `${fields.length} fields`;
    renderResult();
    tabs[1].click();
  } catch (e) {
    alert('Scan aborted: ' + e.message);
  } finally {
    scanning = false;
    $('#btn-scan').textContent = 'Run scan'; $('#btn-scan').classList.remove('stop');
  }
});

/* ---------------- result ---------------- */
function renderResult() {
  if (!fields.length) return;
  const c = cfg();
  const agg = E.aggregate(fields, c.dilution);
  // depth other than 0.1 mm rescales the volume
  const depthAdj = 0.1 / c.depthMm;
  const conc = agg.concentrationPerMl * depthAdj;
  $('#res-empty').hidden = true; $('#res-body').hidden = false;
  $('#r-conc').textContent = conc ? conc.toExponential(2) : '—';
  const L = (k, v) => `<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--line)">
      <span style="font-size:13px">${k}</span><span class="mono" style="font-size:13.5px">${v}</span></div>`;
  $('#r-lines').innerHTML =
    L('Cells counted', agg.total) +
    L('Fields', agg.nFields) +
    L('Counting precision (Poisson)', agg.relSePercent ? '± ' + agg.relSePercent.toFixed(1) + ' %' : '—') +
    L('Field-to-field CV', agg.cvPercent != null ? agg.cvPercent.toFixed(1) + ' %' : '—') +
    (c.viability ? L('Viability', agg.viability != null ? agg.viability.toFixed(1) + ' %' : '—') : '') +
    (c.viability ? L('Viable / non-viable', `${agg.live} / ${agg.dead}`) : '') +
    L('Area counted', agg.areaMm2.toFixed(4) + ' mm²') +
    L('Debris rejected', fields.reduce((a, f) => a + f.nRejected, 0));
  const truthy = fields.filter(f => f.truth != null);
  $('#r-cap').textContent =
    `${agg.total} cells over ${agg.nFields} field(s), ${agg.areaMm2.toFixed(4)} mm² at ${c.umPerPx} µm/px, ` +
    `dilution ${c.dilution}×, depth ${c.depthMm} mm. ` +
    `The ± is Poisson counting error alone; count more fields to shrink it. ` +
    (agg.cvPercent > 2.5 * agg.relSePercent
      ? 'Field-to-field variation exceeds Poisson — the sample is probably not evenly mixed. '
      : '') +
    (truthy.length ? `Demo ground truth: ${truthy.reduce((a, f) => a + f.truth, 0)} cells placed.` : '');
  $('#r-table').innerHTML =
    '<tr><th>#</th><th>Count</th>' + (c.viability ? '<th>Live</th><th>Dead</th>' : '') +
    '<th>Debris</th>' + (truthy.length ? '<th>Truth</th>' : '') + '</tr>' +
    fields.map((f, i) => `<tr><td class="mono">${i + 1}</td><td class="mono">${f.total}</td>` +
      (c.viability ? `<td class="mono" style="color:var(--live)">${f.live}</td><td class="mono" style="color:var(--dead)">${f.dead}</td>` : '') +
      `<td class="mono">${f.nRejected}</td>` +
      (truthy.length ? `<td class="mono">${f.truth ?? '—'}</td>` : '') + '</tr>').join('');
}
$('#btn-csv').addEventListener('click', () => {
  if (!fields.length) return;
  const c = cfg();
  const rows = ['field,count,live,dead,debris_rejected,area_mm2,um_per_px,dilution,depth_mm']
    .concat(fields.map((f, i) => [i + 1, f.total, f.live, f.dead, f.nRejected,
      f.areaMm2.toFixed(5), c.umPerPx, c.dilution, c.depthMm].join(',')));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' }));
  a.download = 'cellcount.csv'; a.click();
});
$('#btn-json').addEventListener('click', async () => {
  if (!fields.length) return;
  const c = cfg();
  const agg = E.aggregate(fields, c.dilution);
  await navigator.clipboard.writeText(JSON.stringify({
    ...agg, concentrationPerMl: agg.concentrationPerMl * (0.1 / c.depthMm),
    settings: c, model: E.getModel().trainedOn, at: new Date().toISOString(),
  }, null, 2));
  $('#btn-json').textContent = 'Copied ✓';
  setTimeout(() => $('#btn-json').textContent = 'Copy summary', 1400);
});

/* ---------------- micrometer calibration ---------------- */
$('#btn-cal').addEventListener('click', () => {
  if (!camOn && !demo) return alert('Start the camera first.');
  const img = grabImage();
  drawFrame(img);
  tabs[0].click();
  const pts = [];
  $('#tag').textContent = 'tap two points on a known division';
  const c = overlay;
  const onTap = ev => {
    const r = c.getBoundingClientRect();
    const x = (ev.clientX - r.left) / r.width * c.width;
    const y = (ev.clientY - r.top) / r.height * c.height;
    pts.push({ x, y });
    const g = c.getContext('2d');
    g.fillStyle = '#e0a458'; g.beginPath(); g.arc(x, y, 6, 0, 7); g.fill();
    if (pts.length === 2) {
      c.removeEventListener('click', onTap);
      g.strokeStyle = '#e0a458'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(pts[0].x, pts[0].y); g.lineTo(pts[1].x, pts[1].y); g.stroke();
      const px = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      const um = parseFloat(prompt(`That span is ${px.toFixed(1)} px. How many µm is it?`, '100'));
      if (isFinite(um) && um > 0) {
        $('#umpx').value = (um / px).toFixed(4);
        alert(`Calibrated: ${(um / px).toFixed(4)} µm/px`);
      }
      $('#tag').textContent = camOn ? 'camera live' : 'demo (synthetic)';
    }
  };
  c.addEventListener('click', onTap);
});

/* ---------------- install / PWA ---------------- */
let deferred = null;
const bI = $('#btn-install');
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; bI.hidden = false; });
bI.addEventListener('click', async () => {
  if (!deferred) return;
  deferred.prompt(); await deferred.userChoice; deferred = null; bI.hidden = true;
});
window.addEventListener('appinstalled', () => { bI.hidden = true; deferred = null; });
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
              (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
if (isIOS && !standalone) $('#ios-hint').hidden = false;

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost'))
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
