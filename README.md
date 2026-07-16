# CellCount

Cell counting on any microscope with a phone at the eyepiece and a motorised stage.
Segmentation, debris rejection, doublet splitting, haemocytometer concentration and
trypan-blue viability all run **on the phone** — no server, no upload, no network after
first load.

> **Research and education use only.** Not a medical device and not a diagnostic. Intended
> for counting cultured cells in a haemocytometer. See `SPEC.md` §9 before using it for
> anything else — the short version is: don't.

## Verified, not asserted

`node test.js` — 30 assertions against synthetic fields with exact ground truth:
**mean absolute error 1.54 %** across 20–150 cells/field, viability within 1 %, exact
concentration arithmetic, stable from 0.1 to 0.6 vignetting. **No real sample has been
counted yet** — `SPEC.md` §8 gives the method-comparison study that would fix that.

## Contents

```
cellcount/
├── index.html          app shell
├── app.js              camera, stage transports, scanning, UI
├── count-engine.js     the counting pipeline + trained model  (unit-tested)
├── synth.js            synthetic field generator (browser Demo + Node tests)
├── train.js            fits the debris classifier            → node train.js
├── test.js             validation harness                    → node test.js
├── firmware/cellscope.ino   ESP32 (BLE) or Arduino (serial) stage firmware
├── pi/bridge.py        Raspberry Pi: serves the app + relays WebSocket → Arduino
├── SPEC.md             method, verification, hardware, limits
├── manifest.json, sw.js, icons, .nojekyll
```

## Two hardware routes

**Route A — ESP32 + Bluetooth (recommended, ~$43 total).** Flash `firmware/cellscope.ino`
with `USE_BLE 1`. Host this folder on GitHub Pages, install the PWA, choose
*Bluetooth* in Setup. Android only — iOS has no Web Bluetooth.

**Route B — Raspberry Pi Zero 2 W + Arduino.** Flash the same sketch with `USE_BLE 0`,
connect the Arduino to the Pi by USB, then on the Pi:

```bash
pip3 install websockets pyserial
python3 pi/bridge.py --serial /dev/ttyUSB0 --root .
```

Browse to `http://<pi-address>:8000` **on the phone** and pick *WebSocket → Pi*.
The app must be served from the Pi: a browser blocks an https page from opening a
`ws://` LAN socket. Consequence: over plain http the PWA will not install.

**A phone cannot talk to an Arduino over USB.** Web Serial does not exist on Android
or iOS. Bluetooth or the Pi are the only two routes that work.

Wiring, driver current limits and the command protocol are all in the sketch header.

## Using it

1. **Setup → Optical calibration.** Put a **stage micrometer** in the light path, tap
   *Calibrate on micrometer*, tap both ends of a known division, enter its length.
   Every number downstream depends on this one. Guessing it from the objective's nominal
   magnification is the commonest route to a confidently wrong concentration.
2. **Setup → Sample.** Cell diameter, dilution, chamber depth, trypan blue on/off.
3. **Setup → Stage link.** Simulator, Bluetooth, or WebSocket. Set µm/step for your
   lead screw and the scan grid.
4. **Scan.** *Count field* for one field, or *Run scan* to serpentine the grid. Fields step
   exactly one field width, so with the edge rule no cell is counted twice or missed.
5. **Result.** Concentration ± Poisson error, viability, per-field table, CSV/JSON export.
   If field-to-field CV exceeds Poisson, the app tells you the sample isn't mixed.

**Demo mode** generates synthetic fields with **known ground truth** and runs them through the
identical engine — check the counter against the truth column before you trust a real sample.

## Retraining

```bash
node train.js    # regenerates the classifier, rewrites weights in count-engine.js
node test.js     # must stay green
```

## Licence

MIT. Cite the accompanying paper (to follow) if used in teaching or research.

---

## Route C — Raspberry Pi does everything (recommended for a fixed bench)

The Pi drives the steppers itself via `pigpio`, which clocks pulses over **DMA** — hardware
timing, unaffected by the Linux scheduler. No Arduino. No STM32. With an HQ camera on a
C-mount, the calibration is fixed per objective forever and **Z autofocus becomes possible**,
which removes the two worst limitations of the phone-at-the-eyepiece build. The phone becomes
a console: display, offline storage, sync.

```
pi/
├── service.js     the whole instrument: capture → autofocus → count → store → stream
├── stage.js       pigpio DMA stepping, X/Y/Z, ramped, with a simulator fallback
├── camera.js      rpicam-still raw RGB (no JPEG artefacts in a measured image)
├── focus.js       Tenengrad metric + coarse/fine search + fast inter-field tracking
├── scan.js        serpentine planner, exact tiling, step-residual carry
├── test-pi.js     22 assertions: autofocus, geometry, quantisation  → node test-pi.js
└── client/        the phone console (SSE live status, offline store, manual sync)
```

**Run it:**

```bash
node pi/test-pi.js            # 22 assertions, no hardware needed
node pi/service.js --sim      # full instrument, simulated, on any laptop
sudo node pi/service.js       # real hardware (pigpio needs root)
```

Then open `http://<pi-address>:8000` on the phone. Zero npm dependencies except optional
`pigpio`; live updates use Server-Sent Events, which are plain HTTP and reconnect by
themselves when a battery-powered rig's wifi blinks.

**Hardware (~$130):** Pi Zero 2 W $15 · HQ camera IMX477 $50 · C-mount adapter $20 ·
3 × NEMA-17 + A4988 $30 · 12 V supply $15. Wiring and pin map in `stage.js`.

**Verified end to end, simulated:** a 3 × 2 scan across a *tilted* slide, autofocusing every
field (59.8 → 76.4 µm) — **375 cells counted against 377 placed, −0.5 %**.
