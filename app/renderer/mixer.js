// SOUND: a channel-strip console in the SSL / Allen & Heath mould. One strip per app playing sound
// (through Core Audio process taps), top to bottom like a real desk: input trim and high-pass, a
// four-band EQ (HF shelf, HMF and LMF sweeps, LF shelf) with EQ IN, output routing, pan, mute / solo,
// a long-throw fader with an LED meter and a scribble strip. The master section on the right is Reel's
// own preview monitor: where you hear the edit, its level and meters. Settings are remembered per app.
import { el, modal, toast } from './ui.js';
import { screwCorners } from './gear.js';
import { audioDevices, fillSelect, recSettings, setMic, permissionNote } from './devices.js';
import { FX_TYPES } from './lib/trackfx.js';
import { gate } from './capability.js';
import { openFxEditor, addFxMenu, fxSlotMenu, removeFx, fxName } from './fxrack.js';
import { openMaster, masterOf } from './master-ui.js';
import { roleButton, tint, openAutoMix } from './automix.js';

const STORE = 'reel.console';
const docIds = new WeakMap(); let docSeq = 0;
let levelHandler = null;

// ------------------------------------------------------------------ fader law (like a real long-throw)
const LAW = [[0, -Infinity], [0.06, -60], [0.16, -40], [0.28, -30], [0.42, -20], [0.58, -10], [0.68, -5], [0.78, 0], [0.89, 5], [1, 10]];
export function faderDb(p) {
  p = Math.max(0, Math.min(1, p));
  for (let i = 1; i < LAW.length; i++) {
    const [p1, d1] = LAW[i], [p0, d0] = LAW[i - 1];
    if (p <= p1) return d0 === -Infinity ? (p <= p0 + 1e-9 ? -Infinity : -60 - (1 - (p - p0) / (p1 - p0)) * 40) : d0 + ((p - p0) / (p1 - p0)) * (d1 - d0);
  }
  return 10;
}
export function faderPos(db) {
  if (!(db > -100)) return 0;
  for (let i = 1; i < LAW.length; i++) {
    const [p1, d1] = LAW[i], [p0, d0] = LAW[i - 1];
    if (db <= d1) return d0 === -Infinity ? p0 + (1 - (-60 - db) / 40) * (p1 - p0) : p0 + ((db - d0) / (d1 - d0)) * (p1 - p0);
  }
  return 1;
}
const dbGain = db => (db === -Infinity ? 0 : 10 ** (db / 20));
const gainDb = g => (g <= 0.00001 ? -Infinity : 20 * Math.log10(g));
const fmtDb = db => (db === -Infinity ? '−∞' : (db > 0 ? '+' : '') + db.toFixed(1) + ' dB');
const fmtHz = f => (f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 0 : 1) + 'k' : Math.round(f) + '');
const logMap = (lo, hi) => ({ toPos: v => Math.log(v / lo) / Math.log(hi / lo), fromPos: p => lo * (hi / lo) ** p });

/** The channel strip's EQ as filters for the audio helper: [kind, freq, gain dB, Q]. */
export function stripFilters(s) {
  if (!s.eqIn && !(s.hpf > 21)) return [];
  const f = [];
  if (s.hpf > 21) f.push([3, s.hpf, 0, 0.7]);
  if (s.eqIn) f.push([1, 100, s.lf, 0.7], [0, s.lmff, s.lmf, 1.2], [0, s.hmff, s.hmf, 1.2], [2, 10000, s.hf, 0.7]);
  return f;
}
export const STRIP_DEFAULT = Object.freeze({ trim: 0, fader: 0, hpf: 20, hf: 0, hmf: 0, hmff: 2500, lmf: 0, lmff: 400, lf: 0, eqIn: true, pan: 0 });
/** Rule volume (0..4) from trim + fader, capped at +12 dB like the helper. */
export const stripVolume = s => Math.min(4, dbGain(s.trim) * dbGain(s.fader));

// System audio services and helpers nobody wants a fader for (shown with SYSTEM on).
const APPLE_APPS = /^com\.apple\.(Music|Safari|TV|podcasts|FaceTime|QuickTimePlayerX|garageband10|logic10|iMovieApp|FinalCut|Keynote|iWork|Photos|VoiceMemos|Notes|mail|Maps|news|Books|iBooksX|Preview|systempreferences)/i;
export function isSystemSound(a) {
  const id = String(a.key || ''), name = String(a.name || '');
  if (/^com\.apple\./i.test(id) || /^com\.apple\./i.test(name)) return !APPLE_APPS.test(id) && !APPLE_APPS.test(name);
  return /helper|daemon|agent|xpc|\bservice\b|coreaudiod|audiomxd|arkaudio/i.test(name + ' ' + id) && !a.icon;
}

// ------------------------------------------------------------------ controls
let readout = null; // the master section's LCD shows whatever was last touched
const show = (label, text) => { if (readout) { readout.firstChild.textContent = label; readout.lastChild.textContent = text; } };

/** A console knob: coloured cap, pointer line, drag up/down (⇧ fine), wheel, double-click resets. */
function knob({ label, color = 'grey', value, def = value, min, max, map, fmt, center = false, title, onInput, size = 30 }) {
  const toPos = map ? map.toPos : v => (v - min) / (max - min);
  const fromPos = map ? map.fromPos : p => min + p * (max - min);
  const cap = el('span', { class: `ck-cap ck-${color}`, style: { width: size + 'px', height: size + 'px' } }, el('i'));
  const wrap = el('div', { class: 'ck' + (center ? ' ck-center' : ''), title: title || label }, el('span', { class: 'ck-label', text: label }), el('span', { class: 'ck-ring' }, cap));
  let v = value;
  const draw = () => { cap.style.transform = `rotate(${-150 + 300 * Math.max(0, Math.min(1, toPos(v)))}deg)`; };
  const set = (nv, fire = true) => { v = nv; draw(); if (fire) { show(label, fmt(v)); onInput(v); } };
  cap.addEventListener('pointerdown', e => {
    e.preventDefault(); cap.setPointerCapture(e.pointerId);
    const y0 = e.clientY, p0 = toPos(v);
    wrap.classList.add('turning');
    const move = ev => { let p = Math.max(0, Math.min(1, p0 + (y0 - ev.clientY) / (ev.shiftKey ? 700 : 160))); if (center && Math.abs(p - 0.5) < 0.015) p = 0.5; set(fromPos(p)); };
    const up = () => { wrap.classList.remove('turning'); cap.removeEventListener('pointermove', move); cap.removeEventListener('pointerup', up); };
    cap.addEventListener('pointermove', move); cap.addEventListener('pointerup', up);
    show(label, fmt(v));
  });
  cap.addEventListener('wheel', e => { e.preventDefault(); set(fromPos(Math.max(0, Math.min(1, toPos(v) + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.005 : 0.025))))); }, { passive: false });
  cap.addEventListener('dblclick', () => set(def));
  cap.addEventListener('pointerenter', () => show(label, fmt(v)));
  draw();
  wrap.setValue = nv => set(nv, false);
  return wrap;
}

/** Lit push button (MUTE red, SOLO yellow, EQ IN green…). */
function push(label, color, on, onClick, title) {
  const b = el('button', { class: `ck-btn ck-btn-${color}` + (on ? ' on' : ''), title: title || label }, el('i', { class: 'ck-led' }), el('span', { text: label }));
  b.addEventListener('click', () => onClick(b));
  return b;
}

/** Long-throw fader with engraved dB scale and a stereo LED meter beside it. */
function fader({ db, onInput, cap = 'white', label = 'Level' }) {
  const scale = el('div', { class: 'cf-scale' }, ...[10, 5, 0, -5, -10, -20, -30, -40, -60].map(d => el('span', { style: { bottom: faderPos(d) * 100 + '%' }, text: d > 0 ? '+' + d : d === 0 ? '0' : String(-d) })), el('span', { class: 'inf', style: { bottom: '0%' }, text: '∞' }));
  const knobEl = el('div', { class: `cf-cap cf-${cap}` }, el('i'));
  const slot = el('div', { class: 'cf-slot' }, el('div', { class: 'cf-groove' }), knobEl);
  // the LED ladder: one canvas for both sides, redrawn only when a level crosses an LED
  const ladder = el('canvas', { class: 'cf-ladder', width: 28, height: 232 });
  // the clip light (lights at 0 dB and stays lit until clicked) and the peak hold above the meter
  const clipLed = el('button', { class: 'cf-clip', type: 'button', text: 'CLIP', title: 'Clip light: lights when the sound reaches 0 dB (distortion) and stays lit. Click to reset it and the peak.' });
  const peakTxt = el('span', { class: 'cf-peak', title: 'Loudest peak so far (click CLIP to reset)', text: '−∞' });
  let hold = -Infinity;
  clipLed.addEventListener('click', e => { e.stopPropagation(); clipLed.classList.remove('on'); hold = -Infinity; peakTxt.textContent = '−∞'; peakTxt.classList.remove('hot'); });
  const box = el('div', { class: 'cf-wrap' }, el('div', { class: 'cf-top' }, clipLed, peakTxt), el('div', { class: 'cf' }, scale, slot, el('div', { class: 'cf-meters' }, ladder)));
  let d = db;
  const draw = () => { knobEl.style.bottom = `calc(${faderPos(d) * 100}% - 13px)`; };
  const setPos = p => { d = faderDb(p); if (Math.abs(d) < 0.6) d = 0; draw(); show(label, fmtDb(d)); onInput(d); };
  const posFromY = y => { const r = slot.getBoundingClientRect(); return 1 - (y - r.top) / r.height; };
  slot.addEventListener('pointerdown', e => {
    e.preventDefault(); slot.setPointerCapture(e.pointerId);
    const onCap = e.target.closest('.cf-cap');
    const p0 = faderPos(d), y0 = e.clientY, h = slot.getBoundingClientRect().height;
    if (!onCap) setPos(posFromY(e.clientY)); // click the slot: the fader jumps there
    const start = onCap ? p0 : faderPos(d), ys = onCap ? y0 : e.clientY;
    const move = ev => setPos(start + (ys - ev.clientY) / (h * (ev.shiftKey ? 4 : 1)));
    const up = () => { slot.removeEventListener('pointermove', move); slot.removeEventListener('pointerup', up); };
    slot.addEventListener('pointermove', move); slot.addEventListener('pointerup', up);
  });
  slot.addEventListener('wheel', e => { e.preventDefault(); setPos(faderPos(d) + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.004 : 0.02)); }, { passive: false });
  knobEl.addEventListener('dblclick', () => setPos(faderPos(0)));
  slot.addEventListener('dblclick', () => setPos(faderPos(0))); // double-click anywhere on the fader: back to 0 dB
  draw();
  let lastL = -1, lastR = -1, gctx = null;
  const LEDS = 16, color = (i, on) => (i >= 14 ? (on ? '#ff3b30' : '#2a1210') : i >= 11 ? (on ? '#ffe03a' : '#262212') : on ? '#45ff5a' : '#142116');
  const meter = (l, r) => {
    const pk = Math.max(l, r);
    if (pk >= 0.999) clipLed.classList.add('on');
    const pdb = gainDb(pk);
    if (pdb > hold + 0.05) { hold = pdb; peakTxt.textContent = (hold > 0 ? '+' : '') + hold.toFixed(1); peakTxt.classList.toggle('hot', hold > -0.5); }
    const lit = v => { const db = gainDb(v); return db === -Infinity ? 0 : Math.max(0, Math.min(LEDS, Math.round((db + 48) / 3))); };
    const a = lit(l), b = lit(r);
    if (a === lastL && b === lastR) return; // nothing changed: no repaint
    lastL = a; lastR = b;
    const H = ladder.clientHeight || 200, k = Math.min(2, devicePixelRatio || 1);
    if (ladder.height !== Math.round(H * k)) { ladder.height = Math.round(H * k); ladder.width = Math.round(28 * k); gctx = null; }
    const g = gctx ||= ladder.getContext('2d');
    g.setTransform(k, 0, 0, k, 0, 0); g.clearRect(0, 0, 28, H);
    const step = (H - 8) / LEDS, hgt = step - 2;
    for (let side = 0; side < 2; side++) {
      const n = side ? b : a, x = side ? 15 : 1;
      for (let i = 0; i < LEDS; i++) { g.fillStyle = color(i, i < n); g.fillRect(x, H - 4 - (i + 1) * step + 1, 12, hgt); }
    }
  };
  requestAnimationFrame(() => meter(0, 0));
  return { el: box, meter, set: nd => { d = nd; draw(); } };
}

// ------------------------------------------------------------------ the console
export async function openMixer(app) {
  const api = app.api;
  const available = await api.audioAvailable().catch(() => false);
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch { /* fresh */ }
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(saved)); } catch { /* fine */ } };
  let showSystem = false, showIdle = false, outputs = [], timer = null;
  const heard = new Map(); // app key -> when it last played sound
  const strips = new Map(); // key -> { el, s, rule, meter, push }
  const solos = new Set();

  const bay = el('div', { class: 'cs-bay' }, el('p', { class: 'cs-empty', text: available ? 'Looking for apps that play sound…' : 'Per-app channels need macOS 14.2 or newer. The monitor section still works.' }));

  const sendAll = () => { for (const st of strips.values()) st.push(true); };
  const makeStrip = (a, n) => {
    const rule = { volume: 1, mute: false, eq: [], output: '', ...(a.rule || {}) };
    const s = { ...STRIP_DEFAULT, ...(saved[a.key] || {}) };
    if (!saved[a.key]) { s.fader = Math.min(10, gainDb(rule.volume || 1)); if (rule.volume > dbGain(10)) { s.trim = gainDb(rule.volume) - 10; s.fader = 10; } s.pan = rule.pan || 0; }
    let tmr = 0, last = 0;
    const pushNow = () => {
      last = performance.now();
      const soloOut = solos.size > 0 && !solos.has(a.key);
      const r = { volume: stripVolume(s), mute: rule.mute || soloOut, eq: rule.eq || [], strip: stripFilters(s), pan: s.pan, output: rule.output || '' };
      api.audioSet(a.key, r).catch(e => toast(e.message, 5000));
    };
    const pushSoon = (now = false) => {
      saved[a.key] = s; save();
      clearTimeout(tmr);
      if (now || performance.now() - last > 90) pushNow(); else tmr = setTimeout(pushNow, 90);
    };
    const upd = (k, after) => v => { s[k] = v; after?.(); pushSoon(); };

    const name = (a.name || a.key).replace(/^com\./i, '');
    const outSel = el('select', { class: 'cs-route', title: 'Route: which speakers or headphones this app plays through' },
      el('option', { value: '', text: 'MAIN' }), ...outputs.map(o => el('option', { value: o.uid, text: o.name.slice(0, 22), selected: o.uid === rule.output })));
    outSel.addEventListener('change', () => { rule.output = outSel.value; show('Route', outSel.selectedOptions[0]?.textContent || 'MAIN'); pushSoon(true); });
    const legacy = (rule.eq || []).some(v => Math.abs(v) > 0.05);
    const legacyBtn = legacy ? push('GEQ', 'amber', true, b => { rule.eq = []; b.remove(); pushSoon(true); toast('The old 10-band EQ is off for this app. The strip EQ stays.'); }, 'An older 10-band EQ is on for this app. Click to switch it off.') : null;
    const eqBtn = push('EQ IN', 'green', s.eqIn, b => { s.eqIn = !s.eqIn; b.classList.toggle('on', s.eqIn); show('EQ', s.eqIn ? 'IN' : 'OUT'); pushSoon(true); }, 'EQ in or out (compare with and without)');
    const muteBtn = push('MUTE', 'red', rule.mute, b => { rule.mute = !rule.mute; b.classList.toggle('on', rule.mute); show('Mute', rule.mute ? 'ON' : 'OFF'); pushSoon(true); });
    const soloBtn = push('SOLO', 'yellow', solos.has(a.key), b => {
      if (solos.has(a.key)) solos.delete(a.key); else solos.add(a.key);
      b.classList.toggle('on', solos.has(a.key)); show('Solo', solos.has(a.key) ? 'ON' : 'OFF'); sendAll();
    }, 'Solo: hear only the soloed apps (lifted when you close the mixer)');
    const fd = fader({ db: s.fader, onInput: upd('fader'), label: name });
    const strip = el('div', { class: 'cs-strip' + (a.active ? '' : ' quiet') },
      el('div', { class: 'cs-num', text: String(n) }),
      el('div', { class: 'cs-sec cs-input' },
        knob({ label: 'TRIM', color: 'red', value: s.trim, def: 0, min: 0, max: 12, fmt: v => '+' + v.toFixed(1) + ' dB', onInput: upd('trim'), title: 'Input trim: up to +12 dB of boost' }),
        knob({ label: 'HPF', color: 'grey', value: s.hpf, def: 20, map: logMap(20, 400), fmt: v => (v <= 21 ? 'OFF' : fmtHz(v) + ' Hz'), onInput: upd('hpf'), size: 24, title: 'High-pass filter: cuts rumble below this (fully left is off)' })),
      el('div', { class: 'cs-sec cs-eq' },
        el('div', { class: 'cs-band' }, knob({ label: 'HF', color: 'red', value: s.hf, def: 0, min: -15, max: 15, center: true, fmt: v => fmtDb(v) + ' @10k', onInput: upd('hf'), title: 'High shelf, 10 kHz: air and sparkle' })),
        el('div', { class: 'cs-band two' },
          knob({ label: 'HMF', color: 'green', value: s.hmf, def: 0, min: -15, max: 15, center: true, fmt: fmtDb, onInput: upd('hmf'), size: 26, title: 'High-mid gain: presence, bite' }),
          knob({ label: 'kHz', color: 'green-s', value: s.hmff, def: 2500, map: logMap(600, 7000), fmt: v => fmtHz(v) + ' Hz', onInput: upd('hmff'), size: 20, title: 'High-mid frequency' })),
        el('div', { class: 'cs-band two' },
          knob({ label: 'LMF', color: 'blue', value: s.lmf, def: 0, min: -15, max: 15, center: true, fmt: fmtDb, onInput: upd('lmf'), size: 26, title: 'Low-mid gain: body, boxiness' }),
          knob({ label: 'Hz', color: 'blue-s', value: s.lmff, def: 400, map: logMap(100, 2000), fmt: v => fmtHz(v) + ' Hz', onInput: upd('lmff'), size: 20, title: 'Low-mid frequency' })),
        el('div', { class: 'cs-band' }, knob({ label: 'LF', color: 'black', value: s.lf, def: 0, min: -15, max: 15, center: true, fmt: v => fmtDb(v) + ' @100', onInput: upd('lf'), title: 'Low shelf, 100 Hz: weight and warmth' })),
        el('div', { class: 'cs-btns' }, eqBtn, legacyBtn)),
      el('div', { class: 'cs-sec cs-mid' },
        el('span', { class: 'ck-label', text: 'ROUTE' }), outSel,
        knob({ label: 'PAN', color: 'red', value: s.pan, def: 0, min: -1, max: 1, center: true, fmt: v => (Math.abs(v) < 0.01 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100)), onInput: upd('pan'), title: 'Pan: left / right' })),
      el('div', { class: 'cs-sec cs-mutes' }, muteBtn, soloBtn),
      fd.el,
      el('div', { class: 'cs-scribble', title: a.name },
        a.icon ? el('img', { src: a.icon, width: 16, height: 16 }) : null,
        el('span', { text: name + (a.active ? '' : ' · quiet') })));
    return { el: strip, s, rule, meter: fd.meter, push: pushNow };
  };

  // Only apps that are playing sound get a strip (and keep it for half a minute after they stop, so a pause
  // in a video doesn't make its strip jump away). macOS also lists apps that merely opened sound earlier
  // (QuickTime Player sitting idle, helpers): IDLE shows those, SYSTEM shows macOS's own sound services.
  const render = apps => {
    const now = performance.now();
    for (const a of apps) if (a.active) heard.set(a.key, now);
    const playing = a => a.active || now - (heard.get(a.key) || -1e9) < 30000;
    const vis = apps.filter(a => (showIdle || playing(a)) && (showSystem || !isSystemSound(a)));
    const idle = apps.filter(a => !playing(a) && (showSystem || !isSystemSound(a))).length, sys = apps.filter(a => isSystemSound(a)).length;
    idleBtn.querySelector('span').textContent = `IDLE${idle ? ` (${idle})` : ''}`;
    sysBtn.querySelector('span').textContent = `SYSTEM${sys ? ` (${sys})` : ''}`;
    const keep = new Set(vis.map(a => a.key));
    for (const k of [...strips.keys()]) if (!keep.has(k)) { strips.get(k).el.remove(); strips.delete(k); }
    if (!vis.length) { if (!bay.querySelector('.cs-strip')) bay.replaceChildren(el('p', { class: 'cs-empty', text: available ? 'No apps are playing sound right now. Play something and it shows up here (IDLE shows apps that are open but silent).' : 'Per-app channels need macOS 14.2 or newer.' })); return; }
    bay.querySelector('.cs-empty')?.remove();
    let n = 0;
    for (const a of vis) {
      n++;
      const st = strips.get(a.key);
      if (st) { st.el.querySelector('.cs-num').textContent = String(n); st.el.classList.toggle('quiet', !a.active); st.el.querySelector('.cs-scribble span').textContent = (a.name || a.key).replace(/^com\./i, '') + (a.active ? '' : ' · quiet'); bay.append(st.el); continue; }
      const made = makeStrip(a, n);
      strips.set(a.key, made);
      bay.append(made.el);
    }
  };
  let lastApps = [];
  const refresh = async () => {
    if (!available) return;
    try { const r = await api.audioList(); outputs = r.outputs; lastApps = r.apps; render(r.apps); }
    catch (e) { bay.replaceChildren(el('p', { class: 'cs-empty', text: e.message })); }
  };
  const sysBtn = push('SYSTEM', 'amber', false, b => { showSystem = !showSystem; b.classList.toggle('on', showSystem); render(lastApps); }, 'Show the macOS sound services and app helpers too');
  const idleBtn = push('IDLE', 'amber', false, b => { showIdle = !showIdle; b.classList.toggle('on', showIdle); render(lastApps); }, 'Also show apps that are open but not playing sound right now');

  // ---------------- master: Reel's monitor strip (player.setMonitor: preview only, never the export)
  const mon = { volume: 1, mute: false, pan: 0, eqIn: true, hpf: 20, lf: 0, lmfF: 400, lmfG: 0, hmfF: 2500, hmfG: 0, hf: 0, sink: '', ...app.player.monitor };
  const setMon = patch => { Object.assign(mon, patch); app.player.setMonitor(patch); };
  const monSel = el('select', { class: 'cs-route wide', title: 'Where you hear Reel: speakers, headphones, or an interface like a Scarlett Solo' });
  const inSel = el('select', { class: 'cs-route wide', title: 'Microphone for recordings and voice-overs (a Scarlett Solo, a USB mic…). The same setting as Settings and the Record window.' });
  const inMeter = el('div', { class: 'cs-inmeter' }, el('i'));
  let inStream = null, inCtx = null, inRaf = 0;
  const stopIn = () => { cancelAnimationFrame(inRaf); inStream?.getTracks().forEach(t => t.stop()); inStream = null; inCtx?.close().catch(() => {}); inCtx = null; };
  const listenIn = async () => {
    stopIn();
    try {
      inStream = await navigator.mediaDevices.getUserMedia({ audio: inSel.value ? { deviceId: { exact: inSel.value }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } : { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      inCtx = new AudioContext(); const an = inCtx.createAnalyser(); an.fftSize = 1024; inCtx.createMediaStreamSource(inStream).connect(an);
      const buf = new Float32Array(1024);
      const tick = () => { an.getFloatTimeDomainData(buf); let p = 0; for (const v of buf) p = Math.max(p, Math.abs(v)); inMeter.firstChild.style.width = Math.min(100, Math.sqrt(p) * 100) + '%'; inMeter.classList.toggle('hot', p > 0.89); inRaf = requestAnimationFrame(tick); };
      tick();
    } catch { inMeter.title = 'The microphone isn’t available (System Settings › Privacy & Security › Microphone).'; }
  };
  const perm = permissionNote(() => fillDevices().then(listenIn), { short: true });
  const fillDevices = async () => {
    const d = await audioDevices();
    perm.update(d);
    fillSelect(monSel, d.outputs, mon.sink, d.defaultOutput, 'Mac’s output');
    fillSelect(inSel, d.inputs, recSettings().micId || '', d.defaultInput, 'Mac’s input');
  };
  inSel.addEventListener('change', () => { setMic(inSel.value); show('Input', inSel.selectedOptions[0]?.textContent || 'Mac’s input'); listenIn(); });
  navigator.mediaDevices.addEventListener?.('devicechange', fillDevices);
  // Space plays / pauses the edit (so you can watch the meters) instead of re-pressing the last button
  const onKey = e => {
    if (e.key !== ' ' || e.target.closest?.('input[type=text], textarea, select')) return;
    e.preventDefault(); e.stopPropagation();
    if (e.repeat) return; // holding Space must not toggle play dozens of times a second
    if (app.doc) app.player.toggle();
  };
  window.addEventListener('keydown', onKey, true);
  const onFocus = () => fillDevices(); // back from System Settings
  window.addEventListener('focus', onFocus);
  fillDevices().then(listenIn);
  monSel.addEventListener('change', () => { setMon({ sink: monSel.value, sinkLabel: (monSel.value ? monSel.selectedOptions[0]?.textContent : '') || '' }); show('Monitor', monSel.selectedOptions[0]?.textContent || 'System'); });
  const monFader = fader({ db: Math.min(10, gainDb(mon.volume)), cap: 'red', label: 'Monitor', onInput: d => setMon({ volume: Math.min(4, dbGain(d)) }) });
  readout = el('div', { class: 'cs-lcd' }, el('b', { text: 'SOUND' }), el('span', { text: 'touch a control' }));
  const mk = (patchKey, o) => knob({ ...o, onInput: v => setMon({ [patchKey]: v }) });
  const master = el('div', { class: 'cs-master' },
    el('div', { class: 'cs-brand' }, el('b', { text: 'PROTOART' }), el('span', { text: 'PR-1 CONSOLE' })),
    readout,
    el('div', { class: 'cs-sec cs-eq' },
      el('span', { class: 'ck-label', text: 'MONITOR EQ' }),
      el('div', { class: 'cs-band two' },
        mk('hf', { label: 'HF', color: 'red', value: mon.hf, def: 0, min: -15, max: 15, center: true, fmt: fmtDb, size: 24 }),
        mk('hpf', { label: 'HPF', color: 'grey', value: mon.hpf, def: 20, map: logMap(20, 400), fmt: v => (v <= 21 ? 'OFF' : fmtHz(v) + ' Hz'), size: 20 })),
      el('div', { class: 'cs-band two' },
        mk('hmfG', { label: 'HMF', color: 'green', value: mon.hmfG, def: 0, min: -15, max: 15, center: true, fmt: fmtDb, size: 24 }),
        mk('hmfF', { label: 'kHz', color: 'green-s', value: mon.hmfF, def: 2500, map: logMap(600, 7000), fmt: v => fmtHz(v) + ' Hz', size: 20 })),
      el('div', { class: 'cs-band two' },
        mk('lmfG', { label: 'LMF', color: 'blue', value: mon.lmfG, def: 0, min: -15, max: 15, center: true, fmt: fmtDb, size: 24 }),
        mk('lmfF', { label: 'Hz', color: 'blue-s', value: mon.lmfF, def: 400, map: logMap(100, 2000), fmt: v => fmtHz(v) + ' Hz', size: 20 })),
      el('div', { class: 'cs-band two' },
        mk('lf', { label: 'LF', color: 'black', value: mon.lf, def: 0, min: -15, max: 15, center: true, fmt: fmtDb, size: 24 }),
        mk('pan', { label: 'BAL', color: 'red', value: mon.pan, def: 0, min: -1, max: 1, center: true, fmt: v => (Math.abs(v) < 0.01 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100)), size: 20 })),
      el('div', { class: 'cs-btns' }, push('EQ IN', 'green', mon.eqIn !== false, b => { setMon({ eqIn: !(mon.eqIn !== false) }); b.classList.toggle('on', mon.eqIn !== false); show('Monitor EQ', mon.eqIn !== false ? 'IN' : 'OUT'); }))),
    el('div', { class: 'cs-sec' }, el('span', { class: 'ck-label', text: 'MONITOR OUT' }), monSel),
    // the master bus of the edit itself (what the export hears): its own plug-ins, loudness and limiter
    app.doc ? el('div', { class: 'cs-sec cs-masterbus' },
      el('span', { class: 'ck-label', text: 'MASTER BUS (EXPORT)' }),
      el('button', { class: 'hw amber', text: `★ MASTER PLUG-INS${(masterOf(app.doc).plugins || []).length ? ` (${masterOf(app.doc).plugins.length})` : ''}…`, title: 'Put your own plug-ins (Waves, iZotope, FabFilter…) on the whole mix, plus loudness and a limiter. They apply to the export.', onclick: () => openMaster(app) })) : null,
    el('div', { class: 'cs-sec cs-mutes' },
      push('MUTE', 'red', !!mon.mute, b => { setMon({ mute: !mon.mute }); b.classList.toggle('on', mon.mute); show('Monitor', mon.mute ? 'MUTED' : 'ON'); }),
      sysBtn, idleBtn,
      push('RESET', 'red', false, async () => { await api.audioReset().catch(() => {}); saved = {}; save(); solos.clear(); strips.clear(); bay.replaceChildren(); show('Reset', 'all apps flat'); refresh(); }, 'Put every app back to normal (flat, 0 dB, centre, main output)')),
    monFader.el,
    el('div', { class: 'cs-scribble master' }, el('span', { text: 'REEL MONITOR' })));

  // ---------------- timeline tracks: one strip per track, in timeline order, plus the microphone input
  const doc = app.doc;
  let lastTouch = 0;
  const touch = () => { if (!doc) return; const now = performance.now(); if (now - lastTouch > 800) app.history.push(app.doc); lastTouch = now; app.setDirty(true); };
  const tracksBay = el('div', { class: 'cs-bay tracks' });
  const trackStrips = [];
  const eqOf = tr => (tr.fx || []).find(f => f.type === 'eq');
  const ensureEq = tr => { let f = eqOf(tr); if (!f) { tr.fx ||= []; f = { id: 'fx' + Math.random().toString(36).slice(2, 8), type: 'eq', params: {} }; tr.fx.unshift(f); } f.params ||= {}; return f; };
  const makeTrackStrip = (tr, n) => {
    const p = () => eqOf(tr)?.params || {};
    const eqK = (key, label, color, o) => knob({ label, color, value: p()[key] ?? o.def, def: o.def, ...o, onInput: v => { touch(); ensureEq(tr).params[key] = v; app.player._applyTrackFx?.(); } });
    const fxList = el('div', { class: 'cs-fxlist' });
    let fxKey = '';
    const drawFx = () => {
      fxKey = JSON.stringify((tr.fx || []).map(f => [f.id, f.type, !!f.off]));
      // each insert: click opens its controls, × removes it, right-click (or ▾) for bypass, presets, move, replace
      fxList.replaceChildren(...(tr.fx || []).map(f => {
        const slot = el('div', { class: 'cs-fxslot' + (f.off ? ' off' : '') },
          el('button', { class: 'cs-fx' + (f.off ? ' off' : ''), 'data-fx': f.id, text: fxName(f), title: f.type === 'au' ? 'Your plug-in: click to open its window · right-click: more' : 'Click: open its controls · right-click: more', onclick: () => openFxEditor(app, tr, f) }),
          el('button', { class: 'cs-fx-x', text: '×', title: 'Remove this effect (⌘Z undoes)', onclick: e => { e.stopPropagation(); removeFx(app, tr, f, drawFx); } }));
        slot.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); fxSlotMenu(app, tr, f, e.clientX, e.clientY, drawFx); });
        return slot;
      }),
        el('button', { class: 'cs-fx add', text: '+ effect', onclick: e => addFxMenu(app, tr, e.clientX, e.clientY) }));
    };
    drawFx();
    const vol = tr.volume ?? 1;
    const fd = fader({ db: Math.min(10, gainDb(vol)), label: tr.name || `Track ${n}`, onInput: d => { touch(); tr.volume = Math.min(4, dbGain(d)); } });
    const muteBtn = push('MUTE', 'red', !!tr.muted, b => { touch(); tr.muted = !tr.muted; b.classList.toggle('on', tr.muted); show('Mute', tr.muted ? 'ON' : 'OFF'); });
    const soloBtn = push('SOLO', 'yellow', !!tr.solo, b => { touch(); tr.solo = !tr.solo; b.classList.toggle('on', tr.solo); show('Solo', tr.solo ? 'ON' : 'OFF'); });
    const auto = tr.auto && (tr.auto.volume?.length || tr.auto.pan?.length);
    const strip = el('div', { class: 'cs-strip track' },
      el('div', { class: 'cs-num', text: String(n) }),
      el('div', { class: 'cs-sec cs-input' }, el('span', { class: 'ck-label', text: 'INSERTS' }), fxList),
      el('div', { class: 'cs-sec cs-eq' },
        el('div', { class: 'cs-band two' },
          eqK('hf', 'HF', 'red', { def: 0, min: -15, max: 15, center: true, fmt: fmtDb, size: 24 }),
          eqK('hpf', 'HPF', 'grey', { def: 20, map: logMap(20, 400), fmt: v => (v <= 21 ? 'OFF' : fmtHz(v) + ' Hz'), size: 20 })),
        el('div', { class: 'cs-band two' },
          eqK('hmf', 'HMF', 'green', { def: 0, min: -15, max: 15, center: true, fmt: fmtDb, size: 24 }),
          eqK('hmfF', 'kHz', 'green-s', { def: 2500, map: logMap(600, 7000), fmt: v => fmtHz(v) + ' Hz', size: 20 })),
        el('div', { class: 'cs-band two' },
          eqK('lmf', 'LMF', 'blue', { def: 0, min: -15, max: 15, center: true, fmt: fmtDb, size: 24 }),
          eqK('lmfF', 'Hz', 'blue-s', { def: 400, map: logMap(100, 2000), fmt: v => fmtHz(v) + ' Hz', size: 20 })),
        el('div', { class: 'cs-band' }, eqK('lf', 'LF', 'black', { def: 0, min: -15, max: 15, center: true, fmt: fmtDb, size: 24 }))),
      el('div', { class: 'cs-sec cs-mid' },
        knob({ label: 'PAN', color: 'red', value: tr.pan ?? 0, def: 0, min: -1, max: 1, center: true, fmt: v => (Math.abs(v) < 0.01 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100)), onInput: v => { touch(); tr.pan = v; }, title: auto ? 'Pan (this track has automation; the lane wins while playing)' : 'Pan: left / right' })),
      el('div', { class: 'cs-sec cs-mutes' }, muteBtn, soloBtn),
      fd.el,
      el('div', { class: 'cs-scribble', title: `${tr.name || ''} — double-click to rename`, ondblclick: () => app.renameTrack(tr) }, el('span', { text: (tr.name || `Track ${n}`).toUpperCase() })),
      roleButton(app, tr, { compact: true }));
    tint(strip, tr);
    strip.addEventListener('contextmenu', e => { e.preventDefault(); app.trackMenu(tr, e.clientX, e.clientY); });
    trackStrips.push({ tr, meter: fd.meter, fxChanged: () => JSON.stringify((tr.fx || []).map(f => [f.id, f.type, !!f.off])) !== fxKey, drawFx });
    return strip;
  };
  // the microphone / interface input on a channel of its own
  const inStrip = el('div', { class: 'cs-strip input' },
    el('div', { class: 'cs-num', text: 'IN' }),
    el('div', { class: 'cs-sec' }, el('span', { class: 'ck-label', text: 'INPUT (MIC)' }), inSel, inMeter, perm,
      el('p', { class: 'cs-hint', text: 'Your microphone or audio interface, for recordings and voice-over. Set which input of an interface in Settings › Audio Hardware.' })),
    el('div', { class: 'cs-scribble' }, el('span', { text: 'MIC INPUT' })));
  // the mix bus: everything the edit plays and exports goes through this fader (like a console's main mix)
  const mixStrip = () => {
    const d = app.doc;
    const fd = fader({ db: Math.min(10, d?.mixGain ?? 0), cap: 'red', label: 'Mix bus', onInput: v => { touch(); app.doc.mixGain = Math.max(-60, Math.min(10, v === -Infinity ? -60 : v)); app.player._applyMixGain?.(); } });
    busMeter = fd.meter;
    // the mix bus's own inserts (a leveler, compressor, limiter… on the whole mix); a limiter is on by default
    const bus = { name: 'Mix bus', get fx() { return app.doc.mixFx; }, set fx(v) { app.doc.mixFx = v; } };
    const list = el('div', { class: 'cs-fxlist' });
    let key = '';
    const drawFx = () => {
      key = JSON.stringify((app.doc.mixFx || []).map(f => [f.id, f.type, !!f.off]));
      list.replaceChildren(...(app.doc.mixFx || []).map(f => {
        const slot = el('div', { class: 'cs-fxslot' + (f.off ? ' off' : '') },
          el('button', { class: 'cs-fx' + (f.off ? ' off' : ''), text: fxName(f), title: 'Click: open its controls · right-click: more', onclick: () => openFxEditor(app, bus, f) }),
          el('button', { class: 'cs-fx-x', text: '×', title: 'Remove this effect (⌘Z undoes)', onclick: e => { e.stopPropagation(); removeFx(app, bus, f, drawFx); } }));
        slot.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); fxSlotMenu(app, bus, f, e.clientX, e.clientY, drawFx); });
        return slot;
      }), el('button', { class: 'cs-fx add', text: '+ effect', onclick: e => addFxMenu(app, bus, e.clientX, e.clientY) }));
    };
    drawFx();
    mixFxCheck = () => { if (JSON.stringify((app.doc?.mixFx || []).map(f => [f.id, f.type, !!f.off])) !== key) drawFx(); };
    return el('div', { class: 'cs-strip mixbus', title: 'Mix bus: the level of the whole edit, for playback and the export' },
      el('div', { class: 'cs-num', text: 'MIX' }),
      el('div', { class: 'cs-sec cs-input' }, el('span', { class: 'ck-label', text: 'INSERTS · MIX' }), list),
      el('div', { class: 'cs-sec' }, el('span', { class: 'ck-label', text: 'MAIN MIX' }), el('p', { class: 'cs-hint', text: 'All tracks sum here, through its inserts (a limiter keeps it from clipping). It changes the export too; MONITOR (right) only changes what you hear.' })),
      fd.el,
      el('div', { class: 'cs-scribble' }, el('span', { text: 'MIX BUS' })));
  };
  let busMeter = null, mixFxCheck = null;
  // a new track (made here, on the timeline, by an import or an undo) gets its strip straight away
  const addStrip = el('div', { class: 'cs-strip add', title: 'Add a track (it gets a channel strip here and a lane on the timeline)' },
    el('button', { class: 'hw', text: '+ TRACK', onclick: () => app.addTrack() }));
  let shownSig = '';
  const sig = () => (app.doc ? app.doc.tracks.map(t => t.id + '|' + (t.name || '')).join(',') : '') + '#' + (app.doc ? docIds.get(app.doc) || docIds.set(app.doc, ++docSeq).get(app.doc) : 0);
  const drawTracks = () => {
    shownSig = sig();
    trackStrips.length = 0;
    tracksBay.replaceChildren();
    const d = app.doc;
    if (d) d.tracks.forEach((tr, i) => tracksBay.append(makeTrackStrip(tr, i + 1)));
    if (!d || !d.tracks.length) tracksBay.append(el('p', { class: 'cs-empty', text: 'Open a project to see its tracks here.' }));
    if (d) tracksBay.append(addStrip, mixStrip());
    tracksBay.append(inStrip);
  };
  drawTracks();
  const trackTimer = setInterval(() => {
    if (sig() !== shownSig) drawTracks();
    for (const t of trackStrips) if (t.fxChanged()) t.drawFx();
    mixFxCheck?.(); // added, removed or bypassed anywhere (rack, undo…)
    for (const t of trackStrips) { const [l, r] = app.player.trackLevel?.(t.tr.id) || [0, 0]; t.meter(l, r); }
    if (busMeter) { const [l, r] = app.player.levels(); busMeter(l * 1.4, r * 1.4); }
  }, 50);

  const tabTracks = el('button', { class: 'cs-tab on', text: 'TIMELINE TRACKS' }), tabApps = el('button', { class: 'cs-tab', text: 'MAC APPS' });
  const autoMixBtn = el('button', { class: 'cs-tab cs-automix', text: '⚖ AUTO MIX', title: 'Set dialogue, music and sound effects against each other automatically (label each track’s colour first: blue dialogue, orange music, green sound FX)', onclick: () => openAutoMix(app) });
  const wrapTracks = el('div', { class: 'cs-bay-wrap' }, tracksBay), wrapApps = el('div', { class: 'cs-bay-wrap hidden' }, bay);
  const showTab = apps => { tabTracks.classList.toggle('on', !apps); tabApps.classList.toggle('on', apps); wrapTracks.classList.toggle('hidden', apps); wrapApps.classList.toggle('hidden', !apps); };
  tabTracks.onclick = () => showTab(false); tabApps.onclick = () => showTab(true);
  gate(tabApps, 'perAppAudio');
  const desk = el('div', { class: 'cs-desk' }, el('div', { class: 'cs-left' }, el('div', { class: 'cs-tabs' }, tabTracks, tabApps, autoMixBtn), wrapTracks, wrapApps), master);
  screwCorners(desk, 10, 6);

  levelHandler = levels => {
    for (const [k, v] of Object.entries(levels)) {
      const st = strips.get(k); if (!st) continue;
      const [l, r] = Array.isArray(v) ? v : [v, v];
      st.meter(l, r);
    }
  };
  if (!app._levelsHooked) { app._levelsHooked = true; api.onAudioLevels(l => levelHandler && levelHandler(l)); }
  let raf = 0;
  let lastTick = 0;
  const monTick = t => { if (t - lastTick > 50) { lastTick = t; const [l, r] = app.player.levels(); monFader.meter(l * 1.4, r * 1.4); } raf = requestAnimationFrame(monTick); };
  raf = requestAnimationFrame(monTick);

  modal('Mixer', el('div', { class: 'cs-wrap' },
    el('p', { class: 'note', text: 'TIMELINE TRACKS: one channel per track of your edit, in timeline order: inserts (effects), EQ, pan, mute, solo and the fader. They change the edit and the export. MIC INPUT is your microphone or interface. MAC APPS: each app playing sound on this Mac (for recording and listening). The master section is where you hear Reel (MONITOR OUT). Drag knobs up or down (⇧ fine), scroll, double-click to reset.' }),
    desk), [{ label: 'Done', cls: 'hw amber', onClick: c => c() }],
  { wide: true, onClose: () => {
    clearInterval(timer); clearInterval(trackTimer); cancelAnimationFrame(raf); levelHandler = null; readout = null;
    if (app.doc) { app.timeline.render(); app.inspector.render(); }
    stopIn(); navigator.mediaDevices.removeEventListener?.('devicechange', fillDevices); window.removeEventListener('focus', onFocus); window.removeEventListener('keydown', onKey, true);
    api.audioMeter?.(false).catch(() => {});
    if (solos.size) { solos.clear(); sendAll(); } // solo is for listening, not a setting
  } }).root.classList.add('console');
  await refresh();
  if (available) api.audioMeter?.(true).catch(() => {}); // a level on every playing app's strip
  timer = setInterval(refresh, 3000);
}
