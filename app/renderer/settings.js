// Settings (⌘,), laid out like a DAW's Preferences: a list of pages on the left.
// Audio Hardware: default input (microphone or interface) and which of its inputs, default output (where you
// hear Reel), sample rate, playback buffer, a test tone and a level meter. Storage: where new projects and
// their recordings are saved (the Mac or an external drive). The input is the one the Record window and
// voice-over use; the output is the mixer's MONITOR OUT.
import { el, modal, toast, ask } from './ui.js';
import { audioDevices, fillSelect, permissionNote } from './devices.js';
import { shortcutsPage } from './shortcuts.js';
import { FEATURES, can, thisMac, isUnlocked, setUnlocked } from './capability.js';
import { themeChoice, setTheme, SKINS, skinChoice, setSkin, effectiveTheme } from './theme.js';
import { PREFS, PAGES, pref } from './prefs.js';

const readRec = () => { try { return JSON.parse(localStorage.getItem('rec-settings') || '{}') || {}; } catch { return {}; } };
const writeRec = patch => { try { localStorage.setItem('rec-settings', JSON.stringify({ ...readRec(), ...patch })); } catch { /* fine */ } };
const gb = n => (n == null ? '' : n > 1e12 ? `${(n / 1e12).toFixed(1)} TB free` : `${Math.round(n / 1e9)} GB free`);

export async function openSettings(app, page = 'general') {
  const api = app.api;
  // ---------------------------------------------------------------- audio hardware
  const micSel = el('select', {}), outSel = el('select', {});
  const rec = readRec();
  const chanSel = el('select', {}, ...[['auto', 'Input 1 (mono)'], ['2', 'Input 2 (mono)'], ['mix', 'Inputs 1 + 2 mixed (mono)'], ['stereo', 'Both, as stereo']].map(([v, t]) => el('option', { value: v, text: t, selected: (rec.micInput || 'auto') === v })));
  chanSel.addEventListener('change', () => { writeRec({ micInput: chanSel.value }); listen(); });
  const rateSel = el('select', {}, ...[[44100, '44100 Hz'], [48000, '48000 Hz (video standard)'], [96000, '96000 Hz']].map(([v, t]) => el('option', { value: v, text: t, selected: Number(rec.recRate || 48000) === v })));
  rateSel.addEventListener('change', () => writeRec({ recRate: Number(rateSel.value) }));
  const mon = app.player.monitor || {};
  const bufSel = el('select', {}, ...[['interactive', 'Small — fastest response (needs a quick Mac)'], ['balanced', 'Medium'], ['playback', 'Large — smoothest, no crackles (default)']].map(([v, t]) => el('option', { value: v, text: t, selected: (mon.latency || 'playback') === v })));
  bufSel.addEventListener('change', () => { app.player.setMonitor({ latency: bufSel.value }); app.player.resetAudio?.(); toast('Playback buffer changed. It takes effect the next time you press play.'); });
  const meter = el('div', { class: 'meter wide' }, el('i')), meterR = el('div', { class: 'meter wide' }, el('i'));
  const macSees = el('p', { class: 'note' });
  let stream = null, raf = 0, ctx = null;
  const stopMic = () => { cancelAnimationFrame(raf); stream?.getTracks().forEach(t => t.stop()); stream = null; ctx?.close().catch(() => {}); ctx = null; meter.firstChild.style.width = meterR.firstChild.style.width = '0%'; };
  const listen = async () => {
    stopMic();
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: micSel.value ? { exact: micSel.value } : undefined, channelCount: { ideal: 2 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      ctx = new AudioContext();
      const split = ctx.createChannelSplitter(2), L = ctx.createAnalyser(), R = ctx.createAnalyser();
      L.fftSize = R.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(split); split.connect(L, 0); split.connect(R, 1);
      const buf = new Float32Array(1024), pk = an => { an.getFloatTimeDomainData(buf); let p = 0; for (const v of buf) p = Math.max(p, Math.abs(v)); return p; };
      const tick = () => { meter.firstChild.style.width = Math.min(100, Math.sqrt(pk(L)) * 100) + '%'; meterR.firstChild.style.width = Math.min(100, Math.sqrt(pk(R)) * 100) + '%'; raf = requestAnimationFrame(tick); };
      tick();
    } catch { toast('That input isn’t available (check System Settings › Privacy & Security › Microphone).', 5000); }
  };
  const perm = permissionNote(() => fill().then(listen));
  const fill = async () => {
    const d = await audioDevices(), r = readRec(), m = app.player.monitor || {};
    perm.update(d);
    fillSelect(micSel, d.inputs, r.micId || '', d.defaultInput, 'System Default');
    fillSelect(outSel, d.outputs, m.sink || '', d.defaultOutput, 'System Default');
    // what macOS itself reports (Core Audio), so a missing interface is easy to tell from a hidden name
    try {
      const outs = (await Promise.race([api.audioList(), new Promise((_, no) => setTimeout(() => no(new Error('slow')), 4000))])).outputs || [];
      macSees.textContent = outs.length ? `macOS sees these outputs: ${outs.map(o => o.name + (o.default ? ' (default)' : '')).join(', ')}.` : '';
    } catch { macSees.textContent = ''; }
  };
  micSel.addEventListener('change', () => { writeRec({ micId: micSel.value }); listen(); });
  outSel.addEventListener('change', () => { app.player.setMonitor({ sink: outSel.value, sinkLabel: (outSel.value ? outSel.selectedOptions[0]?.textContent : '') || '' }); toast(`Reel’s sound now plays through ${outSel.selectedOptions[0].textContent}.`); });
  const test = el('button', { class: 'hw', text: 'TEST TONE' });
  test.addEventListener('click', async () => {
    try {
      const a = new AudioContext();
      if (outSel.value && a.setSinkId) await a.setSinkId(outSel.value);
      const o = a.createOscillator(), g = a.createGain();
      o.frequency.value = 440; g.gain.setValueAtTime(0, a.currentTime); g.gain.linearRampToValueAtTime(0.15, a.currentTime + 0.05); g.gain.linearRampToValueAtTime(0, a.currentTime + 0.8);
      o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + 0.85);
      setTimeout(() => a.close(), 1200);
    } catch (e) { toast(`Couldn’t play through that output: ${e.message}`, 5000); }
  });
  const row = (label, ...kids) => el('div', { class: 'row' }, el('label', { text: label }), ...kids);
  const audioPage = el('div', { class: 'pref-page' },
    el('h3', { class: 'engr', text: 'Audio Hardware' }),
    row('Device class', el('span', { class: 'pref-fixed', text: 'CoreAudio' })),
    row('Default input', micSel),
    row('Input channel', chanSel),
    row('Level', el('div', { class: 'pref-meters' }, meter, meterR)),
    perm,
    row('Default output', outSel, test),
    macSees,
    row('Sample rate', rateSel),
    row('I/O buffer', bufSel),
    el('p', { class: 'note', text: 'The input is used for recordings and voice-overs; the Record window starts with it. An interface like a Scarlett Solo is one stereo device: input 1 is the mic socket, input 2 the instrument socket, so pick the one your mic is in (the meters show which moves). The output is where you hear Reel (playback, scrubbing, previews): the same as MONITOR OUT in MIXER. If you hear crackles while playing, use the Large buffer.' }));

  // ---------------------------------------------------------------- storage
  const where = el('div', { class: 'pref-path' }), free = el('span', { class: 'note' });
  const showWhere = async () => {
    const s = await api.storageGet().catch(() => null);
    if (!s) return;
    where.textContent = s.root; free.textContent = `${s.external ? 'External drive · ' : ''}${gb(s.free)}`;
    resetBtn.disabled = s.isDefault;
  };
  const choose = el('button', { class: 'hw', text: 'CHOOSE…', onclick: async () => { try { const r = await api.storageChoose(); if (r) { toast(`New projects and recordings now go to ${r}.`); showWhere(); } } catch (e) { toast(e.message, 5000); } } });
  const resetBtn = el('button', { class: 'hw', text: 'BACK TO MOVIES', onclick: async () => { await api.storageReset(); showWhere(); } });
  const reveal = el('button', { class: 'hw', text: 'SHOW IN FINDER', onclick: () => api.storageReveal() });
  const storagePage = el('div', { class: 'pref-page' },
    el('h3', { class: 'engr', text: 'Storage' }),
    row('Save new projects in', where),
    row('', free),
    el('div', { class: 'row' }, el('label'), choose, resetBtn, reveal),
    el('p', { class: 'note', text: 'Each project is a folder that holds its recordings, imported media and proxies, so this is where your video files are stored. Pick a folder on an external drive to keep big recordings off the Mac. Projects already saved elsewhere stay where they are and still show on the Projects screen (while their drive is connected).' }));

  // ---------------------------------------------------------------- this Mac
  const macPage = el('div', { class: 'pref-page' });
  const drawMac = () => {
    const m = thisMac();
    const unlock = el('input', { type: 'checkbox', checked: isUnlocked() });
    unlock.addEventListener('change', () => { setUnlocked(unlock.checked); drawMac(); });
    macPage.replaceChildren(
      el('h3', { class: 'engr', text: 'This Mac' }),
      row('Chip', el('span', { class: 'pref-fixed', text: m.chip || 'Apple silicon' })),
      row('Memory', el('span', { class: 'pref-fixed', text: `${Math.round(m.ram)} GB` })),
      row('macOS', el('span', { class: 'pref-fixed', text: m.macos || '—' })),
      el('p', { class: 'note', text: 'Reel is made to run on an 8 GB M1. These options need more and are greyed out where they would struggle (or need a newer macOS); on bigger Macs they are simply there.' }),
      el('div', { class: 'cap-list' }, ...Object.entries(FEATURES).map(([id, f]) => { const r = can(id); return el('div', { class: 'cap-row' + (r.ok ? ' ok' : '') }, el('span', { class: 'cap-dot', text: r.ok ? (r.stretched ? '!' : '✓') : '—' }), el('span', { text: f.name }), el('small', { text: r.ok ? (r.stretched ? 'unlocked: may be slow or run out of memory' : 'available') : r.why })); })),
      el('label', { class: 'row' }, unlock, el('span', { text: 'Let me try the memory-hungry options anyway (they may be slow, or stop with “out of memory”)' })));
  };
  drawMac();

  // ---------------------------------------------------------------- frame
  // ---------------------------------------------------------------- appearance
  const lookPage = el('div', { class: 'pref-page' });
  const drawLook = () => {
    const cur = themeChoice();
    const card = (v, t, h) => el('button', { class: 'starter' + (cur === v ? ' lit' : ''), type: 'button', onclick: () => { setTheme(v); drawLook(); } }, el('b', { text: t }), el('small', { text: h }));
    lookPage.replaceChildren(el('h3', { class: 'engr', text: 'Appearance' }),
      el('div', { class: 'sz-styles' }, card('dark', 'Dark', 'Black anodized faceplate, the studio-at-night look'), card('light', 'Light', 'Brushed aluminium, like a light-grey console'), card('system', 'Match macOS', 'Follows System Settings › Appearance')),
      el('p', { class: 'note', text: 'Knobs, faders, VU meters, the tape reels and the LED displays look the same in both. Switch quickly with View › Light / Dark (⇧⌘L).' }),
      el('h3', { class: 'engr', text: 'Colour scheme' }),
      el('p', { class: 'note', text: 'The same five schemes as ProtoArt Dandelion. Each works with the Light and Dark faceplates; keys and lamps light up in the scheme’s colour.' }),
      el('div', { class: 'sz-styles skin-cards' }, ...Object.entries(SKINS).map(([id, k]) => {
        const light = effectiveTheme() === 'light', m = k.metal[light ? 'light' : 'dark'];
        const hx = n => '#' + n.toString(16).padStart(6, '0');
        const sw = el('span', { class: 'skin-sw', style: { background: `rgb(${m.join(',')})` } },
          el('i', { style: { background: `radial-gradient(circle at 35% 35%, ${hx(k.lit[0])}, ${hx(k.lit[1])} 45%, ${hx(k.lit[2])})`, boxShadow: `0 0 8px rgb(${k.glow.join(',')})` } }),
          el('b', { text: 'Aa', style: { color: hx(k.text[light ? 'light' : 'dark']) } }));
        return el('button', { class: 'starter' + (skinChoice() === id ? ' lit' : ''), type: 'button', onclick: () => { setSkin(id); drawLook(); } },
          sw, el('b', { text: k.name + (id === 'amber' ? ' (Reel’s original)' : '') }), el('small', { text: k.hint }));
      })));
  };
  drawLook();
  // ---------------------------------------------------------------- the rest, built from the list in prefs.js
  const thisRam = thisMac().ram || 8;
  const after = (k, p) => {
    if (k === 'playBuffer') { app.player.setMonitor({ latency: pref(k) }); app.player.resetAudio?.(); }
    if (p.apply === 'prefs' || k === 'timeDisplay') { app.applyPrefs(); if (app.doc) app.renderAll(); }
    if (p.apply === 'resize') app.player.resize();
    if (k === 'proxyMode' || k === 'proxySize') app.proxies?.kick?.();
  };
  const control = (k, p) => {
    const cur = p.get();
    if (p.type === 'check') {
      const cb = el('input', { type: 'checkbox', checked: !!cur });
      cb.addEventListener('change', () => { p.set(cb.checked); after(k, p); });
      return el('label', { class: 'row pref-check' }, cb, el('span', { text: p.label }));
    }
    const sel = el('select', {}, ...p.options.map(([v, t, ram]) => {
      const o = el('option', { value: JSON.stringify(v), text: t, selected: JSON.stringify(v) === JSON.stringify(cur) });
      if (ram && thisRam < ram - 0.5 && !isUnlocked()) { o.disabled = true; o.textContent += ` — needs ${ram} GB`; o.classList.add('gated'); }
      return o;
    }));
    sel.addEventListener('change', () => { p.set(JSON.parse(sel.value)); after(k, p); });
    return row(p.label, sel);
  };
  const schemaPage = (id, title) => {
    const page = el('div', { class: 'pref-page' }, el('h3', { class: 'engr', text: title }));
    for (const [k, p] of Object.entries(PREFS)) if (p.page === id) { page.append(control(k, p)); if (p.help) page.append(el('p', { class: 'note pref-help', text: p.help })); }
    return page;
  };
  const extra = Object.fromEntries(PAGES.map(([id, t]) => [id, [t, schemaPage(id, t)]]));
  const resetBtn2 = el('button', { class: 'hw', text: 'RESET ALL SETTINGS…', onclick: async () => {
    if (!(await ask('Reset all settings?', 'Every setting goes back to how Reel came. Your projects, media and audio device choice are not touched.', 'Reset'))) return;
    try { for (const k of Object.keys(localStorage)) if (/^reel\.(pref\.|smpte|trackH|scrubAudio|proxy|spectral|voiceover|smartZoom|timelapse|presetSound|theme|unlockHeavy|exportLast)/.test(k)) localStorage.removeItem(k); } catch { /* fine */ }
    toast('Settings reset. Reopen Settings to see them.'); app.applyPrefs();
  } });
  extra.general[1].append(el('div', { class: 'row', style: { marginTop: '18px' } }, el('label'), resetBtn2));
  const keysPage = shortcutsPage(app);
  const pages = { general: extra.general, look: ['Appearance', lookPage], audio: ['Audio Hardware', audioPage], playback: extra.playback, timeline: extra.timeline,
    processing: extra.processing, spectral: extra.spectral, storage: ['Media & Storage', storagePage], export: extra.export, keys: ['Keyboard Shortcuts', keysPage], mac: ['This Mac', macPage] };
  const list = el('div', { class: 'pref-list' }), body = el('div', { class: 'pref-body' });
  const go = k => {
    for (const b of list.children) b.classList.toggle('on', b.dataset.k === k);
    body.replaceChildren(pages[k][1]);
    if (k === 'audio') listen(); else stopMic();
    if (k === 'storage') showWhere();
  };
  for (const [k, [label]] of Object.entries(pages)) list.append(el('button', { class: 'pref-item', 'data-k': k, text: label, onclick: () => go(k) }));
  const onDev = () => fill();
  navigator.mediaDevices.addEventListener?.('devicechange', onDev);
  window.addEventListener('focus', onDev);
  // open at once; the device lists fill in when the Mac answers (the audio helper can take a while, or be busy)
  fill().catch(() => {});
  modal('Settings', el('div', { class: 'prefs' }, list, body), [{ label: 'Done', cls: 'hw amber', onClick: c => c() }],
    { wide: true, onClose: () => { keysPage._cleanup?.(); stopMic(); navigator.mediaDevices.removeEventListener?.('devicechange', onDev); window.removeEventListener('focus', onDev); } });
  go(pages[page] ? page : 'general');
}
