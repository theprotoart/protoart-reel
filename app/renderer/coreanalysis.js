// One pass over a media file's sound by the Rust core (reel-core reads the file itself, through Apple's
// decoder): waveform peaks for the timeline and the loudness profile for AUTO MIX together. null when the
// core isn't in this build or can't read the file; the callers then use their JavaScript workers.
const cache = new Map();

export function coreAnalysis(app, file) {
  if (!app.api?.coreAnalyze) return Promise.resolve(null);
  const key = app.token + '/' + file;
  if (!cache.has(key)) {
    cache.set(key, app.api.coreAnalyze(app.token, file).then(r => (r && r.peaks instanceof Float32Array && r.steps instanceof Float32Array ? r : null)).catch(() => null));
  }
  return cache.get(key);
}
export function forgetCoreAnalysis(app, file) { cache.delete(app.token + '/' + file); }
