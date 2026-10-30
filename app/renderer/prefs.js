// Preferences: every setting in one place (Settings, ⌘,), the way Audition, RX and ScreenFlow keep them.
// Each one is stored on this Mac and read by the part of Reel it controls. Some live under older keys
// (the Record window's, the spectral editor's, proxies…), so they stay in step whichever window you change
// them in. Safe to import anywhere: without browser storage (tests) every setting is its default.

const store = typeof localStorage !== 'undefined' ? localStorage : null;
const readJSON = (k, d) => { try { const v = store?.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const writeJSON = (k, v) => { try { store?.setItem(k, JSON.stringify(v)); } catch { /* fine */ } };
/** A field inside an object stored under one key (e.g. rec-settings.fps). */
const inObj = (key, field, def) => ({
  get: () => { const o = readJSON(key, {}) || {}; return o[field] ?? def; },
  set: v => { const o = readJSON(key, {}) || {}; o[field] = v; writeJSON(key, o); },
});
const own = (name, def) => ({ get: () => readJSON('reel.pref.' + name, def), set: v => writeJSON('reel.pref.' + name, v) });

/**
 * page, label, type (select | number | check), options [[value, text]] or min/max/step/unit, help.
 * `ram`: a choice that needs this much memory (greyed out below it; see capability.js).
 */
export const PREFS = {
  // ---------------------------------------------------------------- General
  uiMode: { page: 'general', label: 'Interface', type: 'select', get: () => { try { const v = store?.getItem('reel.mode'); return v === 'full' || v === 'simple' ? v : 'simple'; } catch { return 'simple'; } }, set: v => { try { store?.setItem('reel.mode', v); } catch { /* fine */ } }, options: [['simple', 'Simple: the essentials, big keys and a step-by-step guide'], ['full', 'Full: every tool']], help: 'Also the SIMPLE / FULL switch in the top bar.', apply: 'prefs' },
  autosave: { page: 'general', label: 'Save automatically every', type: 'select', ...own('autosave', 2), options: [[0, 'Never (only when you close)'], [1, '1 minute'], [2, '2 minutes'], [5, '5 minutes'], [10, '10 minutes']], help: 'Your project is also saved whenever you close it or quit.' },
  undoLevels: { page: 'general', label: 'Undo levels', type: 'select', ...own('undoLevels', 200), options: [[50, '50'], [100, '100'], [200, '200'], [500, '500'], [1000, '1000 (uses more memory)']], help: 'How many steps ⌘Z can go back. Takes effect when you open a project.' },
  timeDisplay: { page: 'general', label: 'Time display', type: 'select', get: () => (readJSON('reel.smpte', false) ? 'smpte' : 'seconds'), set: v => writeJSON('reel.smpte', v === 'smpte'), options: [['seconds', 'Minutes and seconds (01:23.4)'], ['smpte', 'Timecode (00:01:23:12)']] },
  reopenLast: { page: 'general', label: 'At launch', type: 'select', ...own('reopenLast', false), options: [[false, 'Show the Projects screen'], [true, 'Open the last project']] },

  // ---------------------------------------------------------------- Playback & Recording
  scrubAudio: { page: 'playback', label: 'Hear sound while scrubbing', type: 'check', get: () => { try { return store?.getItem('reel.scrubAudio') === '1'; } catch { return false; } }, set: v => { try { store?.setItem('reel.scrubAudio', v ? '1' : '0'); } catch { /* fine */ } } },
  playBuffer: { page: 'playback', label: 'Playback buffer', type: 'select', ...inObj('reel.monitor', 'latency', 'playback'), options: [['interactive', 'Small — fastest response'], ['balanced', 'Medium'], ['playback', 'Large — smoothest, no crackles']], help: 'Takes effect the next time you press play.', restart: 'audio' },
  soundSync: { page: 'playback', label: 'Sound sync', type: 'select', ...own('soundSync', 'auto'), options: [['auto', 'Automatic (your sound card’s delay)'], [0, 'Off (0 ms)'], [50, '50 ms'], [100, '100 ms'], [150, '150 ms'], [200, '200 ms'], [250, '250 ms'], [300, '300 ms'], [400, '400 ms'], [500, '500 ms']], help: 'Sound reaches your ears a little after it plays (more with a large playback buffer or an audio interface). Reel plays sound clips that much early, so what you hear lines up with the playhead and the waveform. If speech still looks early or late against its waveform, set it by hand.' },
  recCountdown: { page: 'playback', label: 'Recording countdown', type: 'select', ...inObj('rec-settings', 'countdown', 3), options: [[0, 'None'], [3, '3 seconds'], [5, '5 seconds'], [10, '10 seconds']] },
  recFps: { page: 'playback', label: 'Screen recording frame rate', type: 'select', ...inObj('rec-settings', 'fps', 30), options: [[30, '30 fps'], [60, '60 fps']] },
  recMax: { page: 'playback', label: 'Screen recording size', type: 'select', ...inObj('rec-settings', 'max', '4k'), options: [['native', 'Full resolution', 16], ['4k', 'Up to 4K'], ['1440', 'Up to 1440p'], ['1080', 'Up to 1080p']] },
  recHide: { page: 'playback', label: 'Hide Reel while recording', type: 'check', ...inObj('rec-settings', 'hide', true) },
  recClaps: { page: 'playback', label: 'Clap three times to mark a cut', type: 'select', ...own('recClaps', 'markers'), options: [['off', 'Off'], ['markers', 'Add a marker at each clap signal'], ['cut', 'Cut the claps out, leaving a marker']], help: 'After each recording Reel listens to the microphone for three quick, even claps (and marks ⌥⇧⌘M presses made while recording). Edit › Find Clap Markers does the same for any clip.' },
  recClicks: { page: 'playback', label: 'Record clicks (for click sounds and effects)', type: 'check', ...inObj('rec-settings', 'clicks', true) },
  voPreroll: { page: 'playback', label: 'Voice-over pre-roll (punch in)', type: 'select', ...inObj('reel.voiceover', 'preroll', 2), options: [[1, '1 second'], [2, '2 seconds'], [3, '3 seconds'], [5, '5 seconds']] },
  voCountdown: { page: 'playback', label: 'Voice-over countdown', type: 'select', ...inObj('reel.voiceover', 'countdown', 3), options: [[0, 'None'], [3, '3-2-1'], [5, '5 seconds']] },

  // ---------------------------------------------------------------- Timeline & Editing
  trackH: { page: 'timeline', label: 'Track height', type: 'select', get: () => readJSON('reel.trackH', 'regular'), set: v => writeJSON('reel.trackH', v), options: [['small', 'Compact'], ['regular', 'Regular'], ['large', 'Tall']], apply: 'prefs' },
  snap: { page: 'timeline', label: 'Snapping on when a project opens', type: 'check', ...own('snap', true) },
  transDur: { page: 'timeline', label: 'Default transition length', type: 'select', ...own('transDur', 0.5), options: [[0.25, '0.25 s'], [0.5, '0.5 s'], [0.75, '0.75 s'], [1, '1 s'], [1.5, '1.5 s'], [2, '2 s']] },
  imageDur: { page: 'timeline', label: 'Pictures added for', type: 'select', ...own('imageDur', 5), options: [[2, '2 s'], [3, '3 s'], [5, '5 s'], [8, '8 s'], [10, '10 s']] },
  textDur: { page: 'timeline', label: 'Titles added for', type: 'select', ...own('textDur', 4), options: [[2, '2 s'], [3, '3 s'], [4, '4 s'], [6, '6 s'], [8, '8 s']] },
  zoomOnDrop: { page: 'timeline', label: 'Smart Zoom every video dropped on the timeline', type: 'check', ...inObj('reel.smartZoom', 'onDrop', false) },

  // ---------------------------------------------------------------- Processing & Performance
  previewQuality: { page: 'processing', label: 'Viewer quality', type: 'select', ...own('previewQuality', 'high'), options: [['high', 'Full (sharpest)'], ['balanced', 'Balanced'], ['fast', 'Fast (smoothest on older Macs)']], help: 'How finely the viewer is drawn while editing. Exports are always full quality.', apply: 'resize' },
  proxyMode: { page: 'processing', label: 'Proxies (light copies for smooth editing)', type: 'select', ...inObj('reel.proxy', 'mode', 'auto'), options: [['auto', 'Automatic (4K, HEVC, ProRes)'], ['always', 'Every video'], ['off', 'Off']] },
  proxySize: { page: 'processing', label: 'Proxy size', type: 'select', ...inObj('reel.proxy', 'size', 'half'), options: [['half', 'Half'], ['quarter', 'Quarter (lightest)']] },
  spectralCache: { page: 'processing', label: 'Spectral editor memory', type: 'select', ...own('spectralCache', 384), options: [[128, '128 MB'], [256, '256 MB'], [384, '384 MB (default)'], [768, '768 MB', 16], [1536, '1.5 GB', 32]], help: 'How much edited sound the spectral editor keeps ready. More = faster scrolling on long files.' },
  trackPlugins: { page: 'processing', label: 'Your plug-ins on tracks (Waves, iZotope…)', type: 'select', ...own('trackPlugins', 'export'), options: [['export', 'Apply them when exporting (fastest while editing)'], ['live', 'Render them while editing (hear them as you go)']], help: 'Either way the export has them. When exporting: right-click a plug-in on a strip › Hear it now to preview it.' },
  encoder: { page: 'processing', label: 'Video encoding', type: 'select', ...own('encoder', 'hardware'), options: [['hardware', 'Hardware (fast, uses the media engine)'], ['software', 'Software (slower, for compatibility)']] },

  // ---------------------------------------------------------------- Spectral display
  spN: { page: 'spectral', label: 'FFT size', type: 'select', ...inObj('reel.spectral', 'N', 2048), options: [[1024, '1024 (sharp timing)'], [2048, '2048'], [4096, '4096'], [8192, '8192 (fine pitch)']] },
  spLog: { page: 'spectral', label: 'Frequency scale', type: 'select', ...inObj('reel.spectral', 'log', true), options: [[true, 'Logarithmic (like hearing)'], [false, 'Linear']] },
  spPalette: { page: 'spectral', label: 'Colours', type: 'select', ...inObj('reel.spectral', 'palette', 'reel'), options: [['reel', 'Amber'], ['magma', 'Magma'], ['mono', 'Mono']] },
  spFloor: { page: 'spectral', label: 'Dynamic range', type: 'select', ...inObj('reel.spectral', 'floor', -96), options: [[-72, '72 dB'], [-96, '96 dB'], [-120, '120 dB'], [-140, '140 dB']] },
  spWave: { page: 'spectral', label: 'Waveform over the spectrogram', type: 'select', ...inObj('reel.spectral', 'wave', 0.35), options: [[0, 'Off'], [0.2, 'Faint'], [0.35, 'Medium'], [0.6, 'Strong']] },

  // ---------------------------------------------------------------- Export
  audioBitrate: { page: 'export', label: 'Sound quality (AAC)', type: 'select', ...own('audioBitrate', 192000), options: [[128000, '128 kbit/s'], [192000, '192 kbit/s'], [256000, '256 kbit/s'], [320000, '320 kbit/s']] },
  loudness: { page: 'export', label: 'Loudness for new projects', type: 'select', ...own('loudness', 'youtube'), options: [['off', 'Off'], ['youtube', 'YouTube · −14 LUFS'], ['spotify', 'Spotify / TikTok · −14 LUFS'], ['apple', 'Apple Music · −16 LUFS'], ['podcast', 'Podcast · −16 LUFS'], ['broadcast', 'Broadcast · −23 LUFS']] },
};

export const PAGES = [['general', 'General'], ['playback', 'Playback & Recording'], ['timeline', 'Timeline & Editing'], ['processing', 'Processing & Performance'], ['spectral', 'Spectral Display'], ['export', 'Export']];

/** A setting's current value (its default when nothing is stored). */
export function pref(name) { const p = PREFS[name]; return p ? p.get() : undefined; }
export function setPref(name, v) { const p = PREFS[name]; if (p) p.set(v); }
