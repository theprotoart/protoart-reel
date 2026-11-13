// Built-in starter templates: every one has the six tracks, a title card, a placeholder and an end
// card that fades out at the very end, and survives the project loader's normalize().
import test from 'node:test';
import assert from 'node:assert';
import { applyStarter, STARTERS, DOC_PRESETS } from '../app/renderer/presets.js';
import { normalize, duration } from '../app/renderer/model.js';

test('starters build complete documents', () => {
  for (const st of STARTERS) {
    const doc = applyStarter(normalize({ canvas: { width: 1920, height: 1080, fps: 30 }, tracks: [], clips: [], media: [] }), st);
    const n = normalize(JSON.parse(JSON.stringify(doc)));
    assert.deepStrictEqual(n.tracks.map(t => t.name), ['Title lines', 'Titles', 'B-roll / overlays', 'Main video', 'Voice', 'Music', 'Sound FX']);
    for (const t of n.tracks) { const cs = n.clips.filter(c => c.track === t.id).sort((a, b) => a.start - b.start); for (let i = 1; i < cs.length; i++) assert.ok(cs[i].start >= cs[i - 1].start + cs[i - 1].duration - 1e-9, `${st.id}: nothing overlaps on ${t.name}`); }
    assert.strictEqual(n.canvas.width, st.w); assert.strictEqual(n.canvas.height, st.h);
    assert.strictEqual(duration(n), st.length, st.id);
    const last = n.clips.filter(c => c.start + c.duration === st.length);
    assert.ok(last.length >= 1 && last.every(c => c.transOut.type === 'fade'), `${st.id} end card fades out`);
    assert.ok(n.clips.some(c => c.start === 0 && c.text.size === st.titleSize), `${st.id} title card`);
    for (const c of n.clips) { assert.ok(c.props.y > 0 && c.props.y < 1, 'on screen'); assert.ok(n.tracks.some(t => t.id === c.track)); }
    assert.strictEqual(n.markers.length, 2);
  }
  assert.ok(DOC_PRESETS.every(([, w, h]) => w % 2 === 0 && h % 2 === 0));
});
