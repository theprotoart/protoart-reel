import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// planCallouts lives in callouts.js (which needs a browser): load just it and CTA_KINDS
const src = readFileSync(new URL('../app/renderer/callouts.js', import.meta.url), 'utf8');
const part = src.slice(src.indexOf('export const CTA_KINDS'), src.indexOf('/** Puts a plan')).replaceAll('export const', 'const').replaceAll('export function', 'function');
const { planCallouts } = new Function(part + '\nreturn { planCallouts };')();

test('a 20-minute video gets a call-out every 3 minutes and an end screen', () => {
  const plan = planCallouts(1200, { kinds: ['likeSubscribe', 'commentPrompt'], every: 180, startAfter: 30, endScreen: true });
  const mid = plan.filter(p => p.kind !== 'endCard');
  assert.equal(plan.at(-1).kind, 'endCard');
  assert.equal(plan.at(-1).t + plan.at(-1).dur, 1200);
  assert.deepEqual(mid.slice(0, 3).map(p => p.kind), ['likeSubscribe', 'commentPrompt', 'likeSubscribe']);
  assert.equal(mid[0].t, 30); assert.equal(mid[1].t, 210);
  assert.ok(mid.every(p => p.t + p.dur < plan.at(-1).t)); // none under the end screen
});

test('call-outs move to the start of a nearby sentence', () => {
  const plan = planCallouts(600, { kinds: ['likeButton'], every: 180, startAfter: 30 }, [12, 41.5, 205, 400]);
  assert.deepEqual(plan.map(p => p.t), [41.5, 205, 400, 570]); // 570: no sentence near, kept where planned
});

test('vertical videos: no end screen; short videos still get one call-out', () => {
  const plan = planCallouts(40, { kinds: ['follow'], every: 24, startAfter: 24, endScreen: true, tall: true });
  assert.ok(plan.length >= 1 && plan.every(p => p.kind === 'follow'));
  assert.equal(planCallouts(5, { kinds: ['follow'] }).length, 0);
});
