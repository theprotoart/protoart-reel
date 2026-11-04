import test from 'node:test';
import assert from 'node:assert/strict';
import { builtInPresets, REEL_PRESETS, HANDBRAKE_PRESETS, presetFps, videoBitrate, fromHandBrake, GROUPS } from '../app/renderer/lib/exportpresets.js';

test('HandBrake-style groups, and Reel’s own presets keep their ids', () => {
  const all = builtInPresets();
  assert.ok(['web', 'hq', 'small', 'uhd', 'ipad', 'appstore', 'audio', 'wav', 'gif', 'gifsmall', 'apng'].every(id => all.some(p => p.id === id)));
  for (const g of GROUPS) assert.ok(all.some(p => p.group === g), g);
  assert.equal(new Set(all.map(p => p.id)).size, all.length, 'ids are unique');
  for (const p of HANDBRAKE_PRESETS) assert.ok(['avc', 'hevc'].includes(p.codec), p.name);
  assert.ok(all.some(p => p.name === 'Fast 1080p30') && all.some(p => p.name === 'Social 25 MB 30 Seconds 1080p60') && all.some(p => p.name === 'VideoToolbox H.265 2160p60 4K'));
  assert.equal(REEL_PRESETS[0].id, 'web');
});

test('frame rate: exact, or the project’s up to the preset’s peak (never more)', () => {
  assert.equal(presetFps({ fpsMax: 60 }, 30), 30);
  assert.equal(presetFps({ fpsMax: 30 }, 60), 30);
  assert.equal(presetFps({ fps: 30 }, 60), 30);
  assert.equal(presetFps({}, 25), 25);
});

test('bitrate: a size limit makes the file fit, the sound included', () => {
  const s = { targetMB: 25, abr: 128 };
  const secs = 30, vb = videoBitrate(s, 1920, 1080, 30, secs);
  const bytes = (vb + 128e3) * secs / 8;
  assert.ok(bytes <= 25e6 && bytes > 23e6, `${(bytes / 1e6).toFixed(2)} MB`);
  assert.equal(videoBitrate({ mbps: 12 }, 1920, 1080, 30, 10), 12e6);
  assert.equal(videoBitrate({ q: 0.5 }, 1920, 1080, 30, 10), Math.round(1920 * 1080 * 30 * 0.1 * 0.5));
});

test('HandBrake preset files come in, nearest to what Reel can make', () => {
  const file = { VersionMajor: 47, PresetList: [{ Folder: true, PresetName: 'My Presets', ChildrenArray: [
    { PresetName: 'YT 4K', VideoEncoder: 'x265_10bit', PictureWidth: 3840, PictureHeight: 2160, VideoFramerate: 'auto', VideoQualityType: 2, VideoQualitySlider: 16, FileFormat: 'av_mp4', AudioList: [{ AudioEncoder: 'av_aac', AudioBitrate: 256, AudioMixdown: 'stereo' }] },
    { PresetName: 'Archive AV1', VideoEncoder: 'svt_av1', PictureHeight: 1080, VideoFramerate: '30', VideoFramerateMode: 'cfr', VideoQualityType: 2, VideoQualitySlider: 28, FileFormat: 'av_mkv', AudioList: [{ AudioBitrate: 640, AudioMixdown: '5point1' }] },
    { PresetName: 'Quick VT', VideoEncoder: 'vt_h264', PictureHeight: 720, VideoFramerate: '60', VideoFramerateMode: 'pfr', VideoQualityType: 1, VideoAvgBitrate: 6000 },
  ] }] };
  const { presets, notes } = fromHandBrake(JSON.stringify(file));
  assert.equal(presets.length, 3);
  const [yt, av1, vt] = presets;
  assert.equal(yt.codec, 'hevc'); assert.equal(yt.height, 2160); assert.equal(yt.q, 2, 'RF 16 is twice RF 22'); assert.equal(yt.abr, 256);
  assert.equal(av1.codec, 'hevc'); assert.equal(av1.fps, 30); assert.equal(av1.abr, 320);
  assert.equal(vt.codec, 'avc'); assert.equal(vt.hw, true); assert.equal(vt.fpsMax, 60); assert.equal(vt.mbps, 6);
  assert.ok(presets.every(p => p.custom && p.group === 'Imported from HandBrake'));
  assert.match(notes.join(' '), /AV1 is made as HEVC/); assert.match(notes.join(' '), /MKV is made as MP4/); assert.match(notes.join(' '), /surround/);
  assert.equal(fromHandBrake({ PresetList: [] }).presets.length, 0);
});
