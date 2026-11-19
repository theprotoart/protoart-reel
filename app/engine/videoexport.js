// A video export drawn by the Rust core (reel-core 1.10 vexport) instead of the editor's canvas: one Mac decoder per
// clip (reel-frames --rgba) feeds the core directly, and the core's frames go straight into the Mac's encoder
// (reel-encode), which also encodes the export's mixed sound. Node only connects them: the frames never pass
// through it (each decoder's output is handed to the core as its own file descriptor, 3, 4…, and the core's stdout
// is the encoder's stdin). The plan comes from lib/videoplan.js.
'use strict';
const { spawn } = require('child_process');

const ENV = { PATH: '/usr/bin:/bin', HOME: process.env.HOME || '' };

/**
 * Runs it. o: { coreBin, framesBin, encodeBin, sources: [{ path, from, to, w, h }], body (the job after its first
 * line), out (a new .mp4 path), w, h, fps, codec ('h264' | 'hevc'), vbr, abr (bits/s), sound (a WAV path or null),
 * onProgress(f), signal, overlay (1.12: true when the editor's drawing comes too), onOverlay(writable, part): where to
 * write it, given as soon as the core starts; parts (1.15): [{ sources, body, overlay, frames }] run one after another
 * into the one encoder, in place of sources/body/overlay }. Resolves to { frames } once the file is complete; rejects with the first reason anything
 * gave (and leaves no half-written file to the caller: it's the caller's temporary path).
 */
function videoExport(o) {
  // a long edit comes in parts (1.15): each its own core and decoders, one after another, all into one encoder
  const parts = o.parts && o.parts.length ? o.parts : [{ sources: o.sources, body: o.body, overlay: o.overlay, frames: 0 }];
  return new Promise((resolve, reject) => {
    const procs = [], errs = [];
    let settled = false;
    const finish = (err, v) => {
      if (settled) return;
      settled = true;
      for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
      if (err) reject(err); else resolve(v);
    };
    const why = (name, p) => { let s = ''; p.stderr?.setEncoding('utf8'); p.stderr?.on('data', d => { s = (s + d).slice(-2000); }); return () => s.trim() && `${name}: ${s.trim().split('\n').pop()}`; };
    if (o.signal) { if (o.signal.aborted) return finish(new Error('Cancelled')); o.signal.addEventListener('abort', () => finish(new Error('Cancelled')), { once: true }); }
    let enc, encWhy, encExit;
    try {
      enc = spawn(o.encodeBin, [o.out, String(o.w), String(o.h), String(o.fps), o.codec, String(o.vbr), String(o.abr), o.sound || '-'], { stdio: ['pipe', 'ignore', 'pipe'], env: ENV });
      encWhy = why('encoder', enc);
      procs.push(enc);
      encExit = new Promise(res => { enc.on('error', e => { errs.push(String(e.message || e)); res(-1); }); enc.on('close', c => res(c)); });
    } catch (e) { return finish(e); }
    const totalFrames = parts.reduce((n, pt) => n + (pt.frames || 0), 0);
    let framesBefore = 0, framesOut = 0;
    // one part: its decoders feed its core, whose stdout is the encoder's stdin (this process keeps its own end of
    // that open until the last part's core has it, so the encoder sees the end only after the last part)
    const runPart = (pt, k) => new Promise((done, fail) => {
      const last = k === parts.length - 1;
      const decs = pt.sources.map(s => spawn(o.framesBin, ['--rgba', s.path, String(s.from), String(s.to), String(s.w), String(s.h)], { stdio: ['ignore', 'pipe', 'pipe'], env: ENV }));
      const decWhy = decs.map((d, i) => why(`clip ${i + 1}`, d));
      procs.push(...decs);
      // the core: its stdin the job, its stdout the encoder's stdin, its stderr progress and the answer, and each
      // decoder's frames on 3, 4…
      const core = spawn(o.coreBin, [], { stdio: ['pipe', enc.stdin, 'pipe', ...decs.map(d => d.stdout), ...(pt.overlay ? ['pipe'] : [])], env: ENV });
      procs.push(core);
      // the editor's drawing over the frames (titles and the rest), on the descriptor after the clips'
      if (pt.overlay) { const w = core.stdio[3 + decs.length]; w.on('error', () => {}); o.onOverlay?.(w, k); }
      // this process's own ends of those pipes go, so each side sees the other's end when it comes
      if (last) enc.stdin.destroy();
      for (const d of decs) d.stdout.destroy();
      let answer = null, line = '';
      core.stderr.setEncoding('utf8');
      core.stderr.on('data', d => {
        line += d;
        let i;
        while ((i = line.indexOf('\n')) >= 0) {
          const l = line.slice(0, i).trim(); line = line.slice(i + 1);
          if (!l.startsWith('{')) { errs.push(l); continue; }
          try {
            const m = JSON.parse(l);
            if (m.progress != null) {
              const f = Math.max(0, Math.min(1, m.progress));
              o.onProgress?.(totalFrames ? (framesBefore + f * (pt.frames || 0)) / totalFrames : (k + f) / parts.length);
            } else answer = m;
          } catch { errs.push(l); }
        }
      });
      const exits = [...decs, core].map(p => new Promise(res => { p.on('error', e => { errs.push(String(e.message || e)); res(-1); }); p.on('close', c => res(c)); }));
      core.stdin.on('error', () => {});
      core.stdin.end(Buffer.concat([Buffer.from('RCORE1\nvexport\n'), Buffer.from(pt.body)]));
      Promise.all(exits).then(codes => {
        const coreCode = codes[codes.length - 1];
        if (!answer || !answer.ok) return fail(new Error((answer && answer.error) || errs.pop() || `the Rust core stopped (${coreCode})${parts.length > 1 ? ` in part ${k + 1} of ${parts.length}` : ''}`));
        // a decoder that couldn't read its video (one that just stopped because the core had what it needed is fine)
        const bad = codes.slice(0, decs.length).findIndex(c => c !== 0 && c !== null);
        if (bad >= 0) return fail(new Error(decWhy[bad]() || `clip ${bad + 1}'s video couldn't be read`));
        framesBefore += pt.frames || 0; framesOut += answer.frames || 0;
        done();
      });
    });
    (async () => {
      try {
        for (const [k, pt] of parts.entries()) { if (settled) return; await runPart(pt, k); }
        const encCode = await encExit;
        if (settled) return;
        if (encCode !== 0) return finish(new Error(encWhy() || `the encoder stopped (${encCode})`));
        finish(null, { frames: framesOut });
      } catch (e) { try { enc.stdin.destroy(); } catch { /* gone */ } finish(e); }
    })();
  });
}

module.exports = { videoExport };
