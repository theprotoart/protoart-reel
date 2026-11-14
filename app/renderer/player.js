// Live preview: keeps one media element per clip in step with the timeline clock, draws frames
// with the shared compositor, and plays sound through the elements (volume follows fades).
import { drawFrame } from './compositor.js';
import { slopeAt } from './lib/retime.js';
import { activeClips, sourceTime, mediaById, duration, gainAt, panAt, panGains, clipEnd, spanStart, spanEnd } from './model.js';
import { cursorAt, clicksBetween } from './cursor.js';
import { clickSample } from './lib/click.js';
import { GlFx, parseCube } from './lib/glfx.js';
import { previewFile } from './proxies.js';
import { pref } from './prefs.js';
import { toast } from './ui.js';

export class Player {
  constructor(canvas, app) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.app = app;
    this.time = 0;
    this.playing = false;
    this.els = new Map();     // clip id -> { el, file }
    this.images = new Map();  // media id -> HTMLImageElement
    this.cursors = new Map(); // media id -> cursor data | 'loading'
    this.raf = 0;
    this.listeners = new Set();
    this.drawQueued = false;
    this.routes = new WeakMap(); // media element -> Web Audio gain + balance nodes
    this.scrubbing = false;
    this.rate = 1; // tape-speed switch: 0.5 / 1 / 2 (preview only; export is always real time)
  }

  /**
   * Reel's sound context, opened straight on the chosen output (MONITOR OUT / Settings › Default output), so
   * playback never starts on the Mac's default device and hops over.
   */
  _newCtx() {
    const sink = this.monitor.sink || '', opts = { latencyHint: this.monitor.latency || 'playback' };
    let a;
    try { a = new AudioContext(sink ? { ...opts, sinkId: sink } : opts); this._sink = sink; } catch { a = new AudioContext(opts); this._sink = undefined; }
    this._checkSink(a);
    return a;
  }
  /**
   * Makes sure the sound really is on the chosen output. A saved output can go stale (the interface was
   * replugged, macOS renumbered it): it's found again by name. If it isn't connected, Reel says so instead of
   * quietly playing through the Mac's default output.
   */
  async _checkSink(a) {
    const m = this.monitor, want = m.sink || '';
    if (!want || !navigator.mediaDevices?.enumerateDevices) return;
    let outs = [];
    try { outs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput'); } catch { return; }
    if (a !== this.actx && this.actx) return;
    let id = want;
    if (!outs.some(d => d.deviceId === want)) {
      const name = (m.sinkLabel || '').replace(/^System Default \((.*)\)$/, '$1').trim();
      const same = name && outs.find(d => d.deviceId !== 'default' && (d.label === name || d.label.startsWith(name) || name.startsWith(d.label)));
      if (same) { id = same.deviceId; this.setMonitor({ sink: id, sinkLabel: same.label }); }
      else { toast(`${name || 'The output you chose'} isn’t connected, so Reel is playing through the Mac’s output. Plug it in, or pick another in Settings › Audio Hardware.`, 8000); return; }
    }
    if (a.sinkId !== undefined && a.sinkId !== id && a.setSinkId) {
      try { await a.setSinkId(id); this._sink = id; } catch (e) { toast(`Couldn’t send Reel’s sound to ${m.sinkLabel || 'that output'} (${e.message}).`, 8000); }
    }
  }
  /** Every element's sound meets on one bus, so the VU meters can read the mix. */
  _bus() {
    if (this.bus) return this.bus;
    const a = this.actx;
    // preview mix → monitor strip (high-pass, LF, LMF, HMF, HF, balance, level) → speakers + meters.
    // The monitor only shapes what you hear while editing; exports never pass through it.
    const out = a.createGain();
    const filters = ['highpass', 'lowshelf', 'peaking', 'peaking', 'highshelf'].map(type => { const f = a.createBiquadFilter(); f.type = type; return f; });
    const pan = a.createStereoPanner(), master = a.createGain();
    let node = out;
    for (const f of filters) { node.connect(f); node = f; }
    node.connect(pan); pan.connect(master); master.connect(a.destination);
    const split = a.createChannelSplitter(2);
    const L = a.createAnalyser(), R = a.createAnalyser();
    L.fftSize = R.fftSize = 1024;
    master.connect(split);
    split.connect(L, 0); split.connect(R, 1);
    this.bus = { out, filters, pan, master, L, R, buf: new Float32Array(1024) };
    this._applyMonitor();
    return this.bus;
  }
  /** Monitor settings (per Mac): { volume, mute, pan, eqIn, hpf, lf, lmfF, lmfG, hmfF, hmfG, hf, sink }. */
  get monitor() {
    if (!this._monitor) { try { this._monitor = JSON.parse(localStorage.getItem('reel.monitor') || '{}') || {}; } catch { this._monitor = {}; } }
    return this._monitor;
  }
  setMonitor(patch) {
    Object.assign(this.monitor, patch);
    try { localStorage.setItem('reel.monitor', JSON.stringify(this.monitor)); } catch { /* fine */ }
    this._applyMonitor();
  }
  _applyMonitor() {
    const b = this.bus, m = this.monitor;
    if (!b) return;
    const now = this.actx.currentTime, set = (prm, v) => prm.setTargetAtTime(v, now, 0.015);
    const eq = m.eqIn !== false;
    const [hp, lf, lmf, hmf, hf] = b.filters;
    set(hp.frequency, m.hpf > 20 ? m.hpf : 10); hp.Q.value = 0.707;
    lf.frequency.value = 80; set(lf.gain, eq ? m.lf || 0 : 0);
    lmf.frequency.value = m.lmfF || 400; lmf.Q.value = 1; set(lmf.gain, eq ? m.lmfG || 0 : 0);
    hmf.frequency.value = m.hmfF || 2500; hmf.Q.value = 1; set(hmf.gain, eq ? m.hmfG || 0 : 0);
    hf.frequency.value = 12000; set(hf.gain, eq ? m.hf || 0 : 0);
    set(b.pan.pan, Math.max(-1, Math.min(1, m.pan || 0)));
    set(b.master.gain, m.mute ? 0 : Math.max(0, Math.min(4, m.volume ?? 1)));
    if (this.actx.setSinkId && (m.sink || '') !== (this._sink ?? '')) {
      const want = m.sink || '';
      this._sink = want;
      this.actx.setSinkId(want).then(() => this._sinkError = null, e => {
        this._sink = null;
        // say why once, instead of quietly playing through the Mac's default output
        if (this._sinkError !== want) { this._sinkError = want; toast(`Couldn’t send Reel’s sound to that output (${e.message}). Unplug and replug the interface, or pick it again in Settings › Audio Hardware.`, 8000); }
      });
    }
    // only if Web Audio failed altogether do the clips play by themselves: then they follow the output directly
    // (never otherwise: an element that's also in the mix would be heard twice)
    if (this._noWebAudio) for (const [, r] of this.els) if (r.el.setSinkId && r.el.sinkId !== (m.sink || '')) r.el.setSinkId(m.sink || '').catch(() => {});
  }
  /**
   * Each timeline track has its own bus: its effect chain (EQ, compressor, reverb… as in the export) and a
   * level meter for the mixer. Tracks without effects pass straight through.
   */
  _trackIn(trackId) {
    const a = this.actx, bus = this._bus();
    this.tracks ||= new Map();
    let t = this.tracks.get(trackId || '');
    if (t) return t.in;
    const inp = a.createGain(); inp.channelCount = 2; inp.channelCountMode = 'explicit';
    // the track's meter reads what leaves the track (after its effects)
    const sp = a.createChannelSplitter(2), aL = a.createAnalyser(), aR = a.createAnalyser();
    aL.fftSize = aR.fftSize = 512; sp.connect(aL, 0); sp.connect(aR, 1);
    t = { in: inp, node: null, fx: '', peak: [0, 0], sp, an: [aL, aR], buf: new Float32Array(512) };
    if (this._silenced?.has(trackId || '')) inp.gain.value = 0;
    inp.connect(bus.out); inp.connect(sp);
    this.tracks.set(trackId || '', t);
    this._applyTrackFx();
    return inp;
  }
  /** The mixer's mix bus fader (the whole edit's level; the export uses it too). */
  _applyMixGain() {
    if (!this.bus || !this.doc) return;
    const g = 10 ** ((this.doc.mixGain || 0) / 20);
    if (Math.abs(this.bus.out.gain.value - g) > 1e-4) this.bus.out.gain.setTargetAtTime(g, this.actx.currentTime, 0.015);
  }
  /** Brings each track bus's effects in line with the document (cheap when nothing changed). */
  _applyTrackFx() {
    this._applyMixGain();
    if (!this.actx || !this.tracks || !this.doc) return;
    if (!this._fxModule) {
      this._fxModule = this.actx.audioWorklet.addModule(new URL('./trackfx-worklet.js', import.meta.url)).then(() => { this._fxReady = true; this._applyTrackFx(); }, () => { this._fxModule = null; });
      return;
    }
    if (!this._fxReady) return;
    // the mix bus's inserts: between the mix fader and the monitor section
    const bus = this._bus(), mlist = this.doc.mixFx || [], mkey = JSON.stringify(mlist);
    if (mkey !== this._mixKey) {
      this._mixKey = mkey;
      const want = mlist.some(f => !f.off);
      if (want && !this._mixNode) {
        const node = new AudioWorkletNode(this.actx, 'track-fx', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
        try { bus.out.disconnect(); } catch { /* fine */ }
        bus.out.connect(node); node.connect(bus.filters[0]); this._mixNode = node;
      } else if (!want && this._mixNode) {
        try { bus.out.disconnect(); this._mixNode.disconnect(); } catch { /* fine */ }
        bus.out.connect(bus.filters[0]); this._mixNode = null;
      }
      if (this._mixNode) this._mixNode.port.postMessage({ fx: mlist });
    }
    for (const [id, t] of this.tracks) {
      const tr = this.doc.tracks.find(x => x.id === id), list = (tr && tr.fx) || [], key = JSON.stringify(list);
      if (key === t.fx) continue;
      t.fx = key;
      const want = list.some(f => !f.off);
      if (want && !t.node) {
        const node = new AudioWorkletNode(this.actx, 'track-fx', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
        node.port.onmessage = e => { if (e.data.peak) t.peak = e.data.peak; };
        try { t.in.disconnect(); } catch { /* fine */ }
        t.in.connect(node); node.connect(this._bus().out); node.connect(t.sp); t.node = node;
      } else if (!want && t.node) {
        try { t.in.disconnect(); t.node.disconnect(); } catch { /* fine */ }
        t.in.connect(this._bus().out); t.in.connect(t.sp); t.node = null; t.peak = [0, 0];
      }
      if (t.node) t.node.port.postMessage({ fx: list });
    }
  }
  /** Peak level of a track's sound after its effects (0..1+ per side), for the mixer meters. */
  /** A track handed to the live plug-in player (it plays there instead, through your plug-ins). */
  silenceTrack(trackId, on) {
    this._silenced ||= new Set();
    if (on) this._silenced.add(trackId); else this._silenced.delete(trackId);
    const t = this.tracks?.get(trackId);
    if (t && this.actx) t.in.gain.setTargetAtTime(on ? 0 : 1, this.actx.currentTime, 0.01);
  }
  trackLevel(trackId) {
    const t = this.tracks && this.tracks.get(trackId);
    if (!t || !this.playing) return [0, 0];
    return t.an.map(an => { an.getFloatTimeDomainData(t.buf); let p = 0; for (const v of t.buf) { const x = Math.abs(v); if (x > p) p = x; } return p; });
  }
  /** A new sound engine (after the buffer size changed): elements are rebuilt on the next play. */
  resetAudio() {
    if (this.playing) this.pause();
    for (const id of [...this.els.keys()]) this._drop(id);
    this.actx?.close().catch(() => {});
    this.actx = null; this.bus = null; this._mixNode = null; this._mixKey = undefined; this.tracks = null; this._fxModule = null; this._fxReady = false; this.routes = new WeakMap(); this._clickBuf = null; this._sink = undefined;
    this.syncPaused(); this.queueDraw();
  }
  /** Peak of the monitored mix per side, even when stopped (0 then). */
  monitorLevels() { return this.levels(); }
  /** RMS level of the preview mix per side (linear 0..1+), for the VU meters. */
  levels() {
    if (!this.bus || !this.playing && !this.scrubbing) return [0, 0];
    const b = this.bus, rms = an => { an.getFloatTimeDomainData(b.buf); let s = 0; for (const v of b.buf) s += v * v; return Math.sqrt(s / b.buf.length); };
    return [rms(b.L), rms(b.R)];
  }
  /** Tape speed for the preview (½×, 1×, 2×), like the 3¾ / 7½ / 15 ips switch on a deck. */
  setRate(r) {
    this.rate = r;
    if (this.playing) { this._t0 = this.time; this._p0 = performance.now(); this._syncPlaying(true); }
    this._emit();
  }

  /**
   * Sound goes element → gain (upmixed to stereo) → L/R balance → speakers, so the preview can go
   * above 100% and pan like the export. Falls back to the element's own volume if Web Audio fails.
   */
  _route(el) {
    if (this._noWebAudio) return null;
    let r = this.routes.get(el);
    if (r) return r;
    try {
      this.actx ||= this._newCtx();
      const a = this.actx;
      const src = a.createMediaElementSource(el);
      const gain = a.createGain();
      gain.channelCount = 2; gain.channelCountMode = 'explicit'; gain.channelInterpretation = 'speakers';
      const split = a.createChannelSplitter(2), merge = a.createChannelMerger(2);
      const gl = a.createGain(), gr = a.createGain();
      src.connect(gain); gain.connect(split);
      split.connect(gl, 0); split.connect(gr, 1);
      gl.connect(merge, 0, 0); gr.connect(merge, 0, 1);
      const dest = this._trackIn(el._trackId);
      merge.connect(dest);
      r = { gain, gl, gr, merge, track: el._trackId };
      this.routes.set(el, r);
      return r;
    } catch { this._noWebAudio = true; return null; }
  }
  _drive(e, gain, pan, force) {
    const r = this._route(e);
    if (r && r.track !== e._trackId) { // the clip moved to another track: follow it to that track's bus
      try { r.merge.disconnect(); } catch { /* fine */ }
      r.merge.connect(this._trackIn(e._trackId)); r.track = e._trackId;
    }
    if (r) {
      const now = this.actx.currentTime, [pl, pr] = panGains(pan);
      e.volume = 1; e.muted = gain <= 0.0001;
      const set = (prm, v) => { if (force) prm.setValueAtTime(v, now); else prm.setTargetAtTime(v, now, 0.012); };
      set(r.gain.gain, gain); set(r.gl.gain, pl); set(r.gr.gain, pr);
    } else {
      e.muted = gain <= 0.0001;
      e.volume = Math.min(1, Math.max(0, gain));
    }
  }
  get doc() { return this.app.doc; }
  onTime(fn) { this.listeners.add(fn); }
  _emit() { for (const f of this.listeners) f(this.time); }

  urlFor(m) { return `app://reel/m/${this.app.token}/${encodeURIComponent(m.file)}`; }

  _el(c, m) {
    // the preview plays a video's proxy when it has one (export and full-size stills use the original)
    const file = m.kind === 'video' ? previewFile(m, this._fullRes) : m.file;
    let rec = this.els.get(c.id);
    if (rec && rec.file === file) return rec.el;
    if (rec) this._drop(c.id);
    const el = document.createElement(m.kind === 'audio' ? 'audio' : 'video');
    el.preload = 'auto';
    el.playsInline = true;
    el.src = `app://reel/m/${this.app.token}/${encodeURIComponent(file)}`;
    if (this._noWebAudio && this.monitor.sink && el.setSinkId) el.setSinkId(this.monitor.sink).catch(() => {});
    if (file !== m.file) {
      el.addEventListener('error', () => { // proxy missing or unreadable: fall back to the original
        if (m.proxy && m.proxy.file === file) { m.proxy = null; this.reloadMedia(m.id); }
      }, { once: true });
    }
    this._watch(el);
    this.els.set(c.id, { el, file, proxied: file !== m.file });
    return el;
  }
  /** A media file's proxy arrived or went: swap the clips that use it over to the new file. */
  reloadMedia(mediaId) {
    if (!this.doc) return;
    for (const c of this.doc.clips) if (c.media === mediaId) this._drop(c.id);
    if (this.playing) return;
    this.syncPaused();
    this.queueDraw();
  }
  /** Separate element for a clip's rendered effects file (the picture element is muted then). */
  _fxEl(c) {
    const key = c.id + '#fx', file = c.fx.file;
    let rec = this.els.get(key);
    if (rec) rec.el._trackId = c.track;
    if (rec && rec.file === file) return rec.el;
    if (rec) this._drop(key);
    const el = document.createElement('audio');
    el.preload = 'auto';
    el._trackId = c.track;
    el.src = `app://reel/m/${this.app.token}/${encodeURIComponent(file)}`;
    this.els.set(key, { el, file });
    return el;
  }
  /** Muted mask video for a clip with background removal, kept in step with the clip. */
  _matteEl(c) {
    const key = c.id + '#matte', file = c.matte.file;
    let rec = this.els.get(key);
    if (rec && rec.file === file) return rec.el;
    if (rec) this._drop(key);
    const el = document.createElement('video');
    el.muted = true; el.preload = 'auto'; el.playsInline = true;
    el.src = `app://reel/m/${this.app.token}/${encodeURIComponent(file)}`;
    this._watch(el);
    this.els.set(key, { el, file });
    return el;
  }
  /**
   * While scrubbing, seeks arrive faster than the decoder can land them. Only one seek is in flight
   * per element; the newest target waits and goes when the previous one lands. The element keeps
   * showing its last frame meanwhile, so the preview never blanks (no flicker).
   */
  _watch(el) {
    el.addEventListener('loadeddata', () => { el._shown = true; this.queueDraw(); });
    el.addEventListener('seeked', () => {
      el._shown = true;
      const w = el._want; el._want = null;
      if (w != null && !this.playing && Math.abs(el.currentTime - w) > 0.01) { try { el.currentTime = w; } catch { /* later */ } }
      this.queueDraw();
    });
  }
  _seekTo(el, st, tol = 0.01) {
    if (el.seeking) { el._want = st; return; }
    el._want = null;
    if (Math.abs(el.currentTime - st) > tol) { try { el.currentTime = st; } catch { /* not ready */ } }
  }
  _drop(id) {
    const r = this.els.get(id);
    if (!r) return;
    r.el.pause(); r.el.removeAttribute('src'); r.el.load();
    this.els.delete(id);
  }
  _image(m) {
    let img = this.images.get(m.id);
    if (!img) { img = new Image(); img.src = this.urlFor(m); img.onload = () => this.queueDraw(); this.images.set(m.id, img); }
    return img;
  }
  _cursor(m) {
    if (!m.cursor) return null;
    const c = this.cursors.get(m.id);
    if (c === undefined) {
      this.cursors.set(m.id, 'loading');
      this.app.api.readJson(this.app.token, m.cursor).then(d => { this.cursors.set(m.id, d); this.queueDraw(); }, () => this.cursors.set(m.id, null));
      return null;
    }
    return c === 'loading' ? null : c;
  }

  /**
   * Each live <video> holds a hardware decoder and frame buffers. On an 8 GB Mac a long edit would
   * pile them up, so only clips showing now or starting in the next few seconds keep theirs.
   */
  _trimElements(active) {
    const MAX = 6;
    if (this.els.size <= MAX) return;
    const t = this.time, near = new Set();
    for (const c of this.doc.clips) if (c.type === 'media' && clipEnd(c) > t - 1 && c.start < t + 4) { near.add(c.id); near.add(c.id + '#fx'); near.add(c.id + '#matte'); }
    for (const id of [...this.els.keys()]) if (!active.has(id) && !near.has(id)) this._drop(id);
  }

  /** Drop elements for clips that no longer exist. */
  prune() {
    if (!this.doc) return;
    const ids = new Set(this.doc.clips.map(c => c.id));
    for (const c of this.doc.clips) { if (c.fx && c.fx.file) ids.add(c.id + '#fx'); if (c.matte && c.matte.file) ids.add(c.id + '#matte'); }
    for (const id of [...this.els.keys()]) if (!ids.has(id)) this._drop(id);
  }

  get sources() {
    return {
      // a picture from the project by media id (an end screen's boxes); drawn once it has loaded
      image: id => { const m = mediaById(this.doc, id); if (!m || m.kind !== 'image') return null; const img = this._image(m); return img.complete && img.naturalWidth ? img : null; },
      frame: (c) => {
        const m = mediaById(this.doc, c.media);
        if (!m) return null;
        if (m.kind === 'image') { const img = this._image(m); return img.complete && img.naturalWidth ? { img, w: img.naturalWidth, h: img.naturalHeight } : null; }
        const r = this.els.get(c.id);
        // mid-seek the element still holds its last frame: keep drawing it rather than blanking
        if (!r || !r.el.videoWidth || (r.el.readyState < 2 && !r.el._shown)) return null;
        // a proxy is smaller than the original: say how much (scaled), so the compositor lays it out at the
        // original's size and reads its pixels at the proxy's size. Nothing moves when it swaps in or out.
        if (r.proxied && m.width && m.height) return { img: r.el, w: r.el.videoWidth, h: r.el.videoHeight, rot: 0, scaled: r.el.videoWidth / m.width };
        return { img: r.el, w: r.el.videoWidth, h: r.el.videoHeight, rot: 0 };
      },
      cursor: (c, st) => {
        const m = mediaById(this.doc, c.media);
        const data = m && this._cursor(m);
        return data ? cursorAt(data, m.cursorOffset || 0, st, c.cursor?.smooth || 0) : null;
      },
      input: c => { const m = mediaById(this.doc, c.media); return m ? this._cursor(m) : null; },
      fx: () => { if (this._gl === undefined) { try { this._gl = new GlFx(); } catch { this._gl = null; } } return this._gl; },
      lut: file => {
        this.luts ||= new Map();
        const v = this.luts.get(file);
        if (v === undefined) {
          this.luts.set(file, 'loading');
          fetch(`app://reel/m/${this.app.token}/${encodeURIComponent(file)}`).then(r => r.text()).then(t => { this.luts.set(file, parseCube(t)); this.queueDraw(); }, () => this.luts.set(file, null));
          return null;
        }
        return v === 'loading' ? null : v;
      },
      matte: c => { const r = this.els.get(c.id + '#matte'); return r && r.el.videoWidth && (r.el.readyState >= 2 || r.el._shown) ? { img: r.el } : null; },
    };
  }

  resize() {
    const stage = this.canvas.parentElement;
    const { width: cw, height: ch } = this.doc ? this.doc.canvas : { width: 1920, height: 1080 };
    const zoom = this.app.previewZoom || 'fit';
    const availW = stage.clientWidth - 24, availH = stage.clientHeight - 24;
    let scale = zoom === 'fit' ? Math.min(availW / cw, availH / ch) : Number(zoom) / devicePixelRatio;
    scale = Math.max(0.05, scale);
    const w = Math.round(cw * scale), h = Math.round(ch * scale);
    this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
    // zoomed in past the stage: the picture can be panned, but never further than its own edges
    const pan = this.app.previewPan || (this.app.previewPan = { x: 0, y: 0 });
    const mx = Math.max(0, (w - availW) / 2 + 12), my = Math.max(0, (h - availH) / 2 + 12);
    pan.x = Math.max(-mx, Math.min(mx, pan.x)); pan.y = Math.max(-my, Math.min(my, pan.y));
    this.canvas.style.transform = pan.x || pan.y ? `translate(${Math.round(pan.x)}px, ${Math.round(pan.y)}px)` : '';
    this.fitScale = Math.max(0.05, Math.min(availW / cw, availH / ch));
    // Settings › Processing › Viewer quality (the export is always full size)
    const q = { high: 1, balanced: 0.75, fast: 0.5 }[pref('previewQuality')] || 1;
    const dpr = Math.max(0.5, Math.min(2, devicePixelRatio || 1) * q);
    this.canvas.width = Math.max(2, Math.round(w * dpr)); this.canvas.height = Math.max(2, Math.round(h * dpr));
    this.displayScale = scale;
    this.queueDraw();
  }

  queueDraw() {
    if (this.drawQueued || this.playing) return;
    this.drawQueued = true;
    requestAnimationFrame(() => { this.drawQueued = false; this.draw(); });
  }
  draw() {
    if (!this.doc) return;
    this.ctx.imageSmoothingQuality = 'high';
    drawFrame(this.ctx, this.doc, this.time, this.sources, { unzoom: this.app.dzEdit || null, showCaptions: this.app.showCaptions !== false && (this.doc.captions || []).length > 0 });
    if (this.app.afterDraw) this.app.afterDraw();
  }

  /** Puts every element showing at the current time at the right spot (paused). */
  syncPaused() {
    if (!this.doc) return;
    const active = new Set();
    for (const c of activeClips(this.doc, this.time).concat(this._audioOnly(this.time))) {
      if (c.type !== 'media') continue;
      const m = mediaById(this.doc, c.media);
      if (!m || m.kind === 'image') continue;
      const el = this._el(c, m);
      el._trackId = c.track;
      active.add(c.id);
      el.pause();
      const st = sourceTime(c, this.time);
      this._seekTo(el, st);
      if (c.fx && c.fx.file && !c.fx.bypass) { const fe = this._fxEl(c); active.add(c.id + '#fx'); fe.pause(); this._seekTo(fe, st); }
      if (c.matte && c.matte.file && !c.matte.off) { const me = this._matteEl(c); active.add(c.id + '#matte'); me.pause(); this._seekTo(me, st); }
    }
    for (const [id, r] of this.els) if (!active.has(id)) r.el.pause();
    this._applyTrackFx();
    this._trimElements(active);
    // warm up clips about to start
    this._preload(this.time);
  }
  _audioOnly(t) {
    // clips on hidden tracks still play sound; audio-only media isn't drawn but must play
    return this.doc.clips.filter(c => c.type === 'media' && !c.disabled && t >= spanStart(c) && t < spanEnd(c) && (c.audioOnly || this.doc.tracks.find(x => x.id === c.track)?.hidden || mediaById(this.doc, c.media)?.kind === 'audio'));
  }
  _preload(t) {
    for (const c of this.doc.clips) {
      if (c.type !== 'media' || c.start <= t || c.start > t + 3) continue;
      const m = mediaById(this.doc, c.media);
      if (!m || m.kind === 'image') continue;
      const el = this._el(c, m);
      if (el.paused && Math.abs(el.currentTime - (c.in || 0)) > 0.05) { try { el.currentTime = c.in || 0; } catch { /* later */ } }
    }
  }

  seek(t) {
    if (!this.doc) return;
    this.time = Math.max(0, Math.min(t, Math.max(duration(this.doc), 0)));
    if (this.playing) { this._t0 = this.time; this._p0 = performance.now(); this._syncPlaying(true); }
    else { this.syncPaused(); this.queueDraw(); }
    this._emit();
  }

  play() {
    if (this.playing || !this.doc) return;
    this._lastClickT = null;
    if (!this.actx && this.doc.clips.some(c => c.cursor?.clickSound)) { try { this.actx = this._newCtx(); } catch { /* no click sounds */ } }
    if (this.actx && this.actx.state === 'suspended') this.actx.resume().catch(() => {});
    if (this.time >= duration(this.doc) - 0.05) this.time = 0;
    this.playing = true;
    this._t0 = this.time; this._p0 = performance.now();
    this._syncPlaying(true);
    const tick = () => {
      if (!this.playing) return;
      this.time = this._t0 + (performance.now() - this._p0) / 1000 * this.rate;
      // the sound card's clock wins: the timeline follows the main sound instead of the sound being
      // dragged back to the timeline (every such correction was an audible skip)
      const lead = this._lead;
      if (lead && !lead.el.paused && lead.el.readyState >= 3 && !lead.el.seeking) {
        const tl = lead.c.start + (lead.el.currentTime - (lead.c.in || 0)) / (lead.c.speed || 1) - (lead.shift || 0);
        if (Math.abs(tl - this.time) < 0.5 && Math.abs(tl - this.time) > 0.008) { this.time = tl; this._t0 = tl; this._p0 = performance.now(); }
      }
      if (this.time >= duration(this.doc)) { this.time = duration(this.doc); this.pause(); this._emit(); this.queueDraw(); return; }
      this._syncPlaying(false);
      this._clickSounds();
      this.draw();
      this._emit();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    this._emit();
  }

  /** Click sounds for clips that have them, for the clicks the playhead just passed. */
  _clickSounds() {
    const t1 = this.time, t0 = this._lastClickT ?? t1;
    this._lastClickT = t1;
    if (t1 <= t0 || t1 - t0 > 0.5 || !this.actx) return;
    for (const c of this.doc.clips) {
      const vol = c.cursor && c.cursor.clickSound;
      if (!vol || c.type !== 'media' || t1 < c.start || t0 >= clipEnd(c)) continue;
      const m = mediaById(this.doc, c.media), data = m && this._cursor(m);
      if (!data || !data.clicks) continue;
      const s0 = sourceTime(c, Math.max(t0, c.start)), s1 = sourceTime(c, Math.min(t1, clipEnd(c)));
      for (const st of clicksBetween(data, m.cursorOffset || 0, s0, s1)) {
        this._clickBuf ||= (() => { const b = this.actx.createBuffer(1, clickSample(this.actx.sampleRate).length, this.actx.sampleRate); b.copyToChannel(clickSample(this.actx.sampleRate), 0); return b; })();
        const src = this.actx.createBufferSource(), g = this.actx.createGain();
        src.buffer = this._clickBuf; g.gain.value = vol;
        src.connect(g).connect(this.actx.destination);
        src.start(this.actx.currentTime + Math.max(0, (st - s0) / (c.speed || 1)));
      }
    }
  }

  /**
   * How long sound takes from a playing clip to your ears: Reel's sound card buffers (bigger with "Large —
   * smoothest") and the interface's own. Sound-only clips (the mic, voice-overs, music) are played this far
   * ahead, so what you hear lines up with the playhead and the waveform under it. Video clips carry their own
   * sound and picture together, so they stay as they are. Settings › Playback can set it by hand.
   */
  soundLead() {
    if (!this.playing) return 0;
    const manual = Number(pref('soundSync'));
    if (pref('soundSync') !== 'auto' && Number.isFinite(manual)) return Math.max(0, Math.min(0.8, manual / 1000));
    const a = this.actx;
    if (!a || a.state !== 'running') return 0;
    return Math.max(0, Math.min(0.5, (a.outputLatency || 0) + (a.baseLatency || 0)));
  }
  _soundOnly(c, m) { return c.audioOnly || m.kind === 'audio'; }

  _syncPlaying(force) {
    if (!this.doc) return;
    const active = new Set();
    let lead = null;
    const ahead = this.soundLead() * this.rate;
    for (const c of activeClips(this.doc, this.time).concat(this._audioOnly(this.time + ahead))) {
      if (c.type !== 'media') continue;
      const m = mediaById(this.doc, c.media);
      if (!m || m.kind === 'image') continue;
      // sound-only clips run `ahead` of the playhead (see soundLead); one that has already finished there stops
      const shift = this._soundOnly(c, m) ? ahead : 0;
      if (shift && (this.time + shift >= clipEnd(c) || this.time + shift < c.start)) continue;
      const el = this._el(c, m);
      el._trackId = c.track;
      if (active.has(c.id)) continue;
      active.add(c.id);
      const st = sourceTime(c, this.time + shift);
      // browsers play media at up to 16×: past that the picture runs at 16× and is kept in step by seeking
      // (the re-seek below), and the sound is muted (the export always uses the exact speed)
      // a time map (Elastic Wave, retime curve): the speed where the playhead is; it changes as it plays
      const want = (c.retime ? slopeAt(c.retime, this.time + shift - c.start) : (c.speed || 1)) * this.rate, speed = Math.min(16, Math.max(0.0625, want)), tooFast = want > 16;
      if (el.playbackRate !== speed) el.playbackRate = speed;
      el.preservesPitch = c.audio?.keepPitch !== false; // off: faster sound goes up in pitch, like tape
      const g = (m.hasAudio || m.kind === 'audio') && !tooFast ? gainAt(this.doc, c, this.time + shift - c.start) : 0;
      const fxOn = !!(c.fx && c.fx.file && !c.fx.bypass);
      const pan = m.hasAudio || m.kind === 'audio' ? panAt(this.doc, c, this.time + shift - c.start) : 0;
      const keep = c.audio?.keepPitch !== false;
      const drive = (e, gain, audible) => {
        // only touch the sound graph when something changed (60 updates a second per clip piled up)
        if (force || e._g === undefined || Math.abs(e._g - gain) > 0.002 || e._pan !== pan) { this._drive(e, gain, pan, force); e._g = gain; e._pan = pan; }
        if (e.playbackRate !== speed) e.playbackRate = speed;
        if (e.preservesPitch !== keep) e.preservesPitch = keep;
        if (force) e._want = null;
        // sound is only re-seeked when it is clearly out (a seek is a click); pictures are kept closer
        const tol = audible ? 0.35 : 0.2;
        if (force || Math.abs(e.currentTime - st) > tol) { try { e.currentTime = st; } catch { /* not ready */ } }
        if (e.paused) e.play().catch(() => {});
      };
      const hasSound = g > 0.0001;
      drive(el, fxOn ? 0 : g, hasSound && !fxOn);
      if (fxOn) { const fe = this._fxEl(c); active.add(c.id + '#fx'); drive(fe, g, hasSound); }
      // the longest-running audible clip leads the clock
      if (hasSound && (!lead || clipEnd(c) > clipEnd(lead.c))) lead = { c, el: fxOn ? this._fxEl(c) : el, shift };
      if (c.matte && c.matte.file && !c.matte.off) {
        const me = this._matteEl(c); active.add(c.id + '#matte');
        if (me.playbackRate !== speed) me.playbackRate = speed;
        if (force || Math.abs(me.currentTime - st) > 0.08) { try { me.currentTime = st; } catch { /* later */ } }
        if (me.paused) me.play().catch(() => {});
      }
    }
    this._lead = lead;
    if (force || !this._fxTick || performance.now() - this._fxTick > 250) { this._fxTick = performance.now(); this._applyTrackFx(); }
    for (const [id, r] of this.els) if (!active.has(id) && !r.el.paused) r.el.pause();
    if (force || Math.abs(this.time - (this._lastTrim ?? -9)) > 2) { this._lastTrim = this.time; this._trimElements(active); }
    this._preload(this.time);
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    for (const r of this.els.values()) r.el.pause();
    this.syncPaused();
    this._emit();
  }
  toggle() { if (this.playing) this.pause(); else this.play(); }

  // ---------------------------------------------------------------- scrubbing
  /** Start dragging the playhead. If it was playing, playback picks up again where you let go. */
  beginScrub() {
    this._resumeAfterScrub = this.playing;
    if (this.playing) { this.playing = false; cancelAnimationFrame(this.raf); for (const r of this.els.values()) r.el.pause(); }
    this.scrubbing = true;
  }
  /** Move the playhead while dragging; `audible` plays a short slice of sound at each step. */
  scrubTo(t, audible) {
    if (!this.doc) return;
    this.time = Math.max(0, Math.min(t, Math.max(duration(this.doc), 0)));
    this.syncPaused();
    this.queueDraw();
    this._emit();
    if (audible) this._blip();
  }
  endScrub() {
    if (!this.scrubbing) return;
    this.scrubbing = false;
    clearTimeout(this._blipT);
    // silence every element first: the last scrub slice used to keep playing after you let go
    for (const r of this.els.values()) r.el.pause();
    if (this._resumeAfterScrub) this.play();
    else { this.syncPaused(); this.queueDraw(); }
  }
  _blip() {
    if (this.actx && this.actx.state === 'suspended') this.actx.resume().catch(() => {});
    if (!this.scrubbing) return;
    const playing = [];
    for (const c of activeClips(this.doc, this.time).concat(this._audioOnly(this.time))) {
      if (c.type !== 'media') continue;
      const m = mediaById(this.doc, c.media);
      if (!m || !(m.hasAudio || m.kind === 'audio')) continue;
      const fxOn = !!(c.fx && c.fx.file && !c.fx.bypass);
      const e = fxOn ? this._fxEl(c) : this._el(c, m);
      this._drive(e, gainAt(this.doc, c, this.time - c.start), panAt(this.doc, c, this.time - c.start), true);
      e.play().catch(() => {});
      playing.push(e);
    }
    clearTimeout(this._blipT);
    this._blipT = setTimeout(() => { if (!this.playing) for (const e of playing) e.pause(); }, 90);
  }

  /** Renders a still of the timeline at time t into a new canvas (for thumbnails and posters). */
  async still(t, w, h) {
    const was = this.playing; if (was) this.pause();
    const prev = this.time;
    this.time = t;
    // big stills (thumbnails, freeze frames) come from the originals, not the proxies
    const full = w * h > 640 * 360;
    if (full) this._fullRes = true;
    this.syncPaused();
    // wait for every visible element to land on its frame
    const els = activeClips(this.doc, t).filter(c => c.type === 'media').map(c => this.els.get(c.id)?.el).filter(Boolean);
    await Promise.all(els.map(el => new Promise(res => {
      if (el.readyState >= 2 && !el.seeking) return res();
      const done = () => { el.removeEventListener('seeked', done); el.removeEventListener('loadeddata', done); res(); };
      el.addEventListener('seeked', done); el.addEventListener('loadeddata', done);
      setTimeout(done, 1500);
    })));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { alpha: false });
    ctx.imageSmoothingQuality = 'high';
    drawFrame(ctx, this.doc, t, this.sources);
    if (full) this._fullRes = false;
    this.time = prev;
    this.syncPaused();
    this.queueDraw();
    return c;
  }

  dispose() { this.pause(); for (const id of [...this.els.keys()]) this._drop(id); this.images.clear(); this.cursors.clear(); }
}
