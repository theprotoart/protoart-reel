import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_CHAINS, chainOfTrack, saveChain, loadChains, deleteChain, applyChain, allChains, chainById } from '../app/renderer/lib/chainpresets.js';
import { FX_TYPES } from '../app/renderer/lib/trackfx.js';

const mem = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; };
let n = 0; const id = () => 'fx' + n++;

test('built-in chains use only effects Reel has', () => {
  for (const c of Object.values(BUILTIN_CHAINS)) for (const f of c.chain) assert.ok(FX_TYPES[f.type], `${c.name}: ${f.type}`);
  assert.deepEqual(BUILTIN_CHAINS.tutorial.chain.map(f => f.type), ['declick', 'deess', 'level']);
});

test('save a rack (with your own plug-in and its settings), then put it on another track', () => {
  const store = mem();
  const tr = { fx: [{ id: 'a', type: 'declick', params: { sensitivity: 7 } }, { id: 'b', type: 'au', plugin: 'aufx:ced1', name: 'CEDAR DNS', maker: 'CEDAR', state: 'QUJD' }, { id: 'c', type: 'level', params: {}, off: true }] };
  const p = saveChain('My voice', chainOfTrack(tr), store);
  assert.equal(p.name, 'My voice');
  assert.equal(loadChains(store).length, 1);
  saveChain('my voice', chainOfTrack(tr), store); // same name replaces
  assert.equal(loadChains(store).length, 1);
  const other = { fx: [{ id: 'z', type: 'eq', params: {} }] };
  applyChain(other, loadChains(store)[0].chain, id, { replace: true });
  assert.deepEqual(other.fx.map(f => f.type), ['declick', 'au', 'level']);
  assert.equal(other.fx[1].state, 'QUJD', 'the plug-in keeps its settings');
  assert.equal(other.fx[0].params.sensitivity, 7);
  assert.ok(other.fx[2].off);
  assert.ok(new Set(other.fx.map(f => f.id)).size === 3 && !other.fx.some(f => ['a', 'b', 'c'].includes(f.id)), 'fresh ids');
  assert.ok(chainById(loadChains(store)[0].id, store));
  assert.equal(allChains(store).length, Object.keys(BUILTIN_CHAINS).length + 1);
  deleteChain(loadChains(store)[0].id, store);
  assert.equal(loadChains(store).length, 0);
});

test('adding a chain (not replacing) goes first and doesn’t double an effect', () => {
  const tr = { fx: [{ id: 'x', type: 'level', params: { target: -18 } }, { id: 'y', type: 'reverb', params: {} }] };
  applyChain(tr, BUILTIN_CHAINS.tutorial.chain, id);
  assert.deepEqual(tr.fx.map(f => f.type), ['declick', 'deess', 'level', 'reverb']);
});
