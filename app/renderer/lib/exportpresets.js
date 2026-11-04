// Export presets, grouped like HandBrake's (General, Web, Devices, Hardware, Production), plus Reel's own, and
// HandBrake preset files (.json, exported from HandBrake) turned into Reel presets.
//
// A preset: { id, name, codec ('avc' | 'hevc' | 'aac' | 'wav' | 'gif' | 'apng'), height (0 = project size),
//   fpsMax (the frame rate, but never above the project's: HandBrake's "peak frame rate"), fps (exact),
//   mbps (fixed bitrate) or q (quality level: × Reel's automatic bitrate for the size), targetMB (fit the whole
//   export into this file size: Social, Email, Discord), abr (sound kbps), hw (true: Apple's hardware encoder) }.
// Reel writes MP4 (H.264 or HEVC) with stereo AAC, so presets for AV1, MKV or surround sound are made as close as
// Reel can, and say what changed.

/** Quality levels, like HandBrake's Very Fast / Fast / HQ / Super HQ tiers: × the automatic bitrate. */
export const QUALITY = [[0.5, 'Very fast (smallest)'], [0.7, 'Fast'], [1, 'HQ (automatic)'], [1.4, 'Super HQ'], [2.5, 'Production (largest)']];
/** File size limits for "fit into" presets (email, chat, social). */
export const SIZE_LIMITS = [[0, 'No limit'], [8, '8 MB'], [10, '10 MB (Discord)'], [25, '25 MB (social)'], [26.2, '25 MiB (email)'], [50, '50 MB'], [100, '100 MB'], [250, '250 MB'], [500, '500 MB (Discord Nitro)']];

const P = (group, id, name, o) => ({ group, id, name, ...o });
const tiers = (prefix, label, q) => [
  P('General', `hb-${prefix}-2160`, `${label} 2160p60 4K HEVC`, { codec: 'hevc', height: 2160, fpsMax: 60, q }),
  P('General', `hb-${prefix}-1080`, `${label} 1080p30`, { codec: 'avc', height: 1080, fpsMax: 30, q }),
  P('General', `hb-${prefix}-720`, `${label} 720p30`, { codec: 'avc', height: 720, fpsMax: 30, q }),
  P('General', `hb-${prefix}-576`, `${label} 576p25`, { codec: 'avc', height: 576, fpsMax: 25, q }),
  P('General', `hb-${prefix}-480`, `${label} 480p30`, { codec: 'avc', height: 480, fpsMax: 30, q }),
];

/** Reel's own presets (their ids are kept: exports remember the last one used). */
export const REEL_PRESETS = [
  P('Reel', 'web', 'Web 1080p · H.264', { codec: 'avc', height: 1080, mbps: 12 }),
  P('Reel', 'hq', 'High quality · HEVC at project size', { codec: 'hevc', height: 0, mbps: 0 }),
  P('Reel', 'small', 'Small 720p · H.264 (email, chat)', { codec: 'avc', height: 720, mbps: 4 }),
  P('Reel', 'uhd', '4K · HEVC', { codec: 'hevc', height: 2160, mbps: 40 }),
  P('Reel', 'ipad', 'iPhone / iPad · H.264 1080p', { codec: 'avc', height: 1080, mbps: 10 }),
  P('Reel', 'appstore', 'App Store preview · H.264 1080p 30 fps', { codec: 'avc', height: 1080, mbps: 10, fps: 30 }),
  P('Reel', 'audio', 'Sound only · AAC (.m4a)', { codec: 'aac', height: 0, mbps: 0 }),
  P('Reel', 'wav', 'Sound only · WAV (uncompressed)', { codec: 'wav', height: 0, mbps: 0 }),
  P('Reel', 'gif', 'Animated GIF · 640 wide, 12 fps', { codec: 'gif', width: 640, fps: 12, dither: true }),
  P('Reel', 'gifsmall', 'Animated GIF · 480 wide, 10 fps (chat)', { codec: 'gif', width: 480, fps: 10, dither: true }),
  P('Reel', 'apng', 'Animated PNG · 800 wide, 15 fps (sharp UI)', { codec: 'apng', width: 800, fps: 15 }),
];

/** The HandBrake-style collection. */
export const HANDBRAKE_PRESETS = [
  ...tiers('vf', 'Very Fast', 0.5), ...tiers('f', 'Fast', 0.7), ...tiers('hq', 'HQ', 1), ...tiers('shq', 'Super HQ', 1.4),
  P('Web', 'hb-creator-2160', 'Creator 2160p60 4K', { codec: 'hevc', height: 2160, fpsMax: 60, q: 1.3 }),
  P('Web', 'hb-creator-1440', 'Creator 1440p60 2.5K', { codec: 'avc', height: 1440, fpsMax: 60, q: 1.3 }),
  P('Web', 'hb-creator-1080', 'Creator 1080p60', { codec: 'avc', height: 1080, fpsMax: 60, q: 1.3 }),
  P('Web', 'hb-creator-720', 'Creator 720p60', { codec: 'avc', height: 720, fpsMax: 60, q: 1.3 }),
  P('Web', 'hb-yt-2160', 'YouTube HQ 2160p60 4K', { codec: 'hevc', height: 2160, fpsMax: 60, q: 1.2 }),
  P('Web', 'hb-yt-1080', 'YouTube HQ 1080p60', { codec: 'avc', height: 1080, fpsMax: 60, q: 1.2 }),
  P('Web', 'hb-social-30s', 'Social 25 MB 30 Seconds 1080p60', { codec: 'avc', height: 1080, fpsMax: 60, targetMB: 25, abr: 128 }),
  P('Web', 'hb-social-1m', 'Social 25 MB 1 Minute 720p60', { codec: 'avc', height: 720, fpsMax: 60, targetMB: 25, abr: 128 }),
  P('Web', 'hb-social-2m', 'Social 25 MB 2 Minutes 540p60', { codec: 'avc', height: 540, fpsMax: 60, targetMB: 25, abr: 96 }),
  P('Web', 'hb-social-5m', 'Social 25 MB 5 Minutes 360p60', { codec: 'avc', height: 360, fpsMax: 60, targetMB: 25, abr: 64 }),
  P('Web', 'hb-discord-nitro', 'Discord Nitro Large 3–6 Minutes 1080p30', { codec: 'avc', height: 1080, fpsMax: 30, targetMB: 500, abr: 160 }),
  P('Web', 'hb-discord-small', 'Discord Small 2 Minutes 360p30', { codec: 'avc', height: 360, fpsMax: 30, targetMB: 10, abr: 64 }),
  P('Web', 'hb-email-1m', 'Email 25 MiB 1 Minute 720p30', { codec: 'avc', height: 720, fpsMax: 30, targetMB: 26.2, abr: 128 }),
  P('Web', 'hb-email-2m', 'Email 25 MiB 2 Minutes 540p30', { codec: 'avc', height: 540, fpsMax: 30, targetMB: 26.2, abr: 96 }),
  P('Web', 'hb-email-5m', 'Email 25 MiB 5 Minutes 360p30', { codec: 'avc', height: 360, fpsMax: 30, targetMB: 26.2, abr: 64 }),
  P('Devices', 'hb-apple-2160', 'Apple 2160p60 4K HEVC', { codec: 'hevc', height: 2160, fpsMax: 60, q: 1 }),
  P('Devices', 'hb-apple-1080-60', 'Apple 1080p60', { codec: 'avc', height: 1080, fpsMax: 60, q: 1 }),
  P('Devices', 'hb-apple-1080', 'Apple 1080p30', { codec: 'avc', height: 1080, fpsMax: 30, q: 1 }),
  P('Devices', 'hb-apple-720', 'Apple 720p30', { codec: 'avc', height: 720, fpsMax: 30, q: 1 }),
  P('Devices', 'hb-apple-540', 'Apple 540p30', { codec: 'avc', height: 540, fpsMax: 30, q: 1 }),
  P('Devices', 'hb-android-1080', 'Android 1080p30', { codec: 'avc', height: 1080, fpsMax: 30, q: 0.9 }),
  P('Devices', 'hb-android-720', 'Android 720p30', { codec: 'avc', height: 720, fpsMax: 30, q: 0.9 }),
  P('Devices', 'hb-chromecast-2160', 'Chromecast 2160p60 4K HEVC', { codec: 'hevc', height: 2160, fpsMax: 60, q: 1 }),
  P('Devices', 'hb-chromecast-1080', 'Chromecast 1080p60', { codec: 'avc', height: 1080, fpsMax: 60, q: 1 }),
  P('Devices', 'hb-fire-2160', 'Amazon Fire 2160p60 4K HEVC', { codec: 'hevc', height: 2160, fpsMax: 60, q: 1 }),
  P('Devices', 'hb-fire-1080', 'Amazon Fire 1080p30', { codec: 'avc', height: 1080, fpsMax: 30, q: 1 }),
  P('Devices', 'hb-ps-2160', 'Playstation 2160p60 4K', { codec: 'hevc', height: 2160, fpsMax: 60, q: 1 }),
  P('Devices', 'hb-ps-1080', 'Playstation 1080p30', { codec: 'avc', height: 1080, fpsMax: 30, q: 1 }),
  P('Devices', 'hb-roku-2160', 'Roku 2160p60 4K HEVC', { codec: 'hevc', height: 2160, fpsMax: 60, q: 1 }),
  P('Devices', 'hb-roku-1080', 'Roku 1080p30', { codec: 'avc', height: 1080, fpsMax: 30, q: 1 }),
  P('Devices', 'hb-xbox-1080', 'Xbox 1080p30', { codec: 'avc', height: 1080, fpsMax: 30, q: 1 }),
  P('Hardware', 'hb-vt-h265-2160', 'VideoToolbox H.265 2160p60 4K', { codec: 'hevc', height: 2160, fpsMax: 60, q: 1, hw: true }),
  P('Hardware', 'hb-vt-h265-1080', 'VideoToolbox H.265 1080p', { codec: 'hevc', height: 1080, q: 1, hw: true }),
  P('Hardware', 'hb-vt-h264-1080', 'VideoToolbox H.264 1080p', { codec: 'avc', height: 1080, q: 1, hw: true }),
  P('Production', 'hb-prod-max', 'Production Max', { codec: 'hevc', height: 0, q: 3, abr: 320 }),
  P('Production', 'hb-prod-standard', 'Production Standard', { codec: 'avc', height: 0, q: 2, abr: 256 }),
  P('Production', 'hb-prod-proxy-1080', 'Production Proxy 1080p', { codec: 'avc', height: 1080, q: 0.6 }),
  P('Production', 'hb-prod-proxy-540', 'Production Proxy 540p', { codec: 'avc', height: 540, q: 0.6 }),
];

export const GROUPS = ['Reel', 'General', 'Web', 'Devices', 'Hardware', 'Production'];
export const builtInPresets = () => [...REEL_PRESETS, ...HANDBRAKE_PRESETS];

/** The frame rate a preset gives on a project: exact (fps), capped (fpsMax, never more than the project), or the project's. */
export function presetFps(p, projectFps = 30) {
  if (p.fps) return p.fps;
  if (p.fpsMax) return Math.min(p.fpsMax, projectFps);
  return projectFps;
}

/**
 * The video bitrate (bits per second) for settings s at w × h, fps, over secs: fitted to a file size limit
 * (the sound's share taken off first), a fixed bitrate, or Reel's automatic bitrate × the quality level.
 */
export function videoBitrate(s, w, h, fps, secs) {
  if (s.targetMB > 0 && secs > 0) {
    const total = s.targetMB * 1e6 * 8 * 0.96; // 4% for the MP4's own index and a little headroom
    const audio = (s.abr || 128) * 1000 * secs;
    return Math.max(150e3, Math.round((total - audio) / secs));
  }
  if (s.mbps > 0) return Math.round(s.mbps * 1e6 * (fps > 30 ? 1.5 : 1));
  return Math.round(w * h * fps * 0.1 * (s.q || 1));
}

// ------------------------------------------------------------------ HandBrake preset files

const hbCodec = enc => {
  const e = String(enc || '').toLowerCase();
  if (/265|hevc/.test(e)) return { codec: 'hevc', hw: e.startsWith('vt_') || undefined };
  if (/264|avc/.test(e)) return { codec: 'avc', hw: e.startsWith('vt_') || undefined };
  if (/av1/.test(e)) return { codec: 'hevc', note: 'AV1 is made as HEVC' };
  if (/vp9|vp8|theora|mpeg/.test(e)) return { codec: 'avc', note: `${enc} is made as H.264` };
  return { codec: 'avc' };
};

/**
 * Turns a HandBrake preset file (File › Export… in HandBrake's Presets window) into Reel presets. Returns
 * { presets, notes }: notes say what Reel had to change (AV1 → HEVC, MKV → MP4, surround → stereo…).
 */
export function fromHandBrake(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const flat = [];
  const walk = list => { for (const p of list || []) { if (p && (p.Folder || p.ChildrenArray)) walk(p.ChildrenArray); else if (p && typeof p === 'object') flat.push(p); } };
  walk(Array.isArray(data) ? data : data?.PresetList || (data?.PresetName ? [data] : []));
  const presets = [], notes = [];
  for (const h of flat.slice(0, 50)) {
    const name = String(h.PresetName || 'HandBrake preset').slice(0, 60);
    const why = [];
    const c = hbCodec(h.VideoEncoder);
    if (c.note) why.push(c.note);
    if (h.FileFormat && !/mp4/i.test(h.FileFormat)) why.push(`${String(h.FileFormat).replace(/^av_/, '').toUpperCase()} is made as MP4`);
    const audio = (h.AudioList || [])[0] || {};
    if (/5point1|7point1|6ch|surround/i.test(String(audio.AudioMixdown || ''))) why.push('surround sound is made as stereo');
    const p = { id: 'hb' + Math.random().toString(36).slice(2, 9), name, custom: true, group: 'Imported from HandBrake', codec: c.codec };
    if (c.hw) p.hw = true;
    const ph = Number(h.PictureHeight) || 0, pw = Number(h.PictureWidth) || 0;
    // HandBrake's sizes are limits (the picture is scaled down to fit), so the height is the smaller side
    if (ph > 0) p.height = ph; else if (pw > 0) p.height = Math.round(pw * 9 / 16); else p.height = 0;
    const fr = Number(h.VideoFramerate);
    if (fr > 0) { if (h.VideoFramerateMode === 'cfr') p.fps = fr; else p.fpsMax = fr; }
    if (Number(h.VideoQualityType) === 1 && Number(h.VideoAvgBitrate) > 0) p.mbps = Math.round(Number(h.VideoAvgBitrate) / 100) / 10;
    else if (h.VideoQualitySlider != null) {
      // RF (constant quality): lower is better. RF 22 is about Reel's automatic bitrate; every 6 halves or doubles it
      const rf = Number(h.VideoQualitySlider);
      if (Number.isFinite(rf)) p.q = Math.round(Math.max(0.25, Math.min(4, 2 ** ((22 - rf) / 6))) * 100) / 100;
    }
    if (Number(audio.AudioBitrate) > 0) p.abr = Math.max(64, Math.min(320, Number(audio.AudioBitrate)));
    if (h.PresetDescription) p.hint = String(h.PresetDescription).slice(0, 160);
    presets.push(p);
    if (why.length) notes.push(`${name}: ${why.join(', ')}`);
  }
  return { presets, notes };
}
