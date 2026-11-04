// Effect-chain presets: a whole track rack (built-in effects and your own plug-ins, with their settings) saved under
// a name, to put on any track later or to have Auto Edit put on the voice. A few come built in; yours are kept on
// this Mac. A chain is a list of { type, params, preset?, off? } or, for your own plug-ins,
// { type: 'au', plugin, name, maker, state }.

export const BUILTIN_CHAINS = {
  tutorial: { name: 'Tutorial voice', hint: 'De-click → De-ess → Auto Level: mouth clicks out, “s” softened, words even',
    chain: [{ type: 'declick', preset: 'Mouth clicks (voice)', params: { sensitivity: 5, length: 0.5 } }, { type: 'deess', params: {} }, { type: 'level', preset: 'Voice — even', params: { target: -20, boost: 12, cut: 12, speed: 1500 } }] },
  light: { name: 'Clean dialogue (light)', hint: 'Gentle de-click and Auto Level',
    chain: [{ type: 'declick', preset: 'Gentle', params: { sensitivity: 3, length: 0.4 } }, { type: 'level', preset: 'Voice — even', params: { target: -20, boost: 12, cut: 12, speed: 1500 } }] },
  podcast: { name: 'Podcast voice', hint: 'De-click → EQ for clarity → compressor → de-ess → tight Auto Level',
    chain: [{ type: 'declick', preset: 'Mouth clicks (voice)', params: { sensitivity: 5, length: 0.5 } }, { type: 'eq', preset: 'Voice — clarity', params: { hpf: 80, lf: -2, lmf: -3, lmfF: 300, hmf: 2, hmfF: 3000, hf: 3 } },
      { type: 'comp', preset: 'Voice — podcast', params: { threshold: -24, ratio: 4, attack: 5, release: 100, makeup: 6 } }, { type: 'deess', params: {} }, { type: 'level', preset: 'Podcast — tight', params: { target: -18, boost: 15, cut: 12, speed: 700 } }] },
  noisy: { name: 'Noisy room', hint: 'Rumble filter → noise gate → de-click → Auto Level',
    chain: [{ type: 'eq', preset: 'Remove rumble', params: { hpf: 100 } }, { type: 'gate', params: {} }, { type: 'declick', params: {} }, { type: 'level', params: {} }] },
};

const KEY = 'reel.chainPresets';
const MAX = 60;

/** Your saved chains: { id, name, chain }[]. */
export function loadChains(store = globalThis.localStorage) {
  try { const v = JSON.parse(store?.getItem(KEY) || '[]'); return Array.isArray(v) ? v.filter(p => p && typeof p.name === 'string' && Array.isArray(p.chain)) : []; } catch { return []; }
}
function saveChains(list, store = globalThis.localStorage) {
  try { store?.setItem(KEY, JSON.stringify(list.slice(0, MAX))); return true; } catch { return false; }
}

/** A track's rack as a chain to keep (no ids; your plug-ins keep their settings). */
export function chainOfTrack(tr) {
  return (tr.fx || []).map(f => f.type === 'au'
    ? { type: 'au', plugin: f.plugin, name: f.name, maker: f.maker, state: f.state || '', ...(f.off ? { off: true } : {}) }
    : { type: f.type, params: { ...(f.params || {}) }, ...(f.preset ? { preset: f.preset } : {}), ...(f.off ? { off: true } : {}) });
}

/** Saves (or replaces, by name) a chain. Returns the saved preset, or null if it couldn't be stored. */
export function saveChain(name, chain, store = globalThis.localStorage) {
  const clean = String(name || '').trim().slice(0, 60);
  if (!clean || !chain.length) return null;
  const list = loadChains(store).filter(p => p.name.toLowerCase() !== clean.toLowerCase());
  const p = { id: 'u' + Date.now().toString(36), name: clean, chain: JSON.parse(JSON.stringify(chain)) };
  return saveChains([p, ...list], store) ? p : null;
}
export function deleteChain(id, store = globalThis.localStorage) { saveChains(loadChains(store).filter(p => p.id !== id), store); }

/** Every chain you can pick: built-in ones (id = their key) then yours (id = 'u…'). */
export function allChains(store = globalThis.localStorage) {
  return [...Object.entries(BUILTIN_CHAINS).map(([id, c]) => ({ id, name: c.name, hint: c.hint, chain: c.chain, builtin: true })), ...loadChains(store)];
}
export const chainById = (id, store = globalThis.localStorage) => allChains(store).find(c => c.id === id) || null;

/**
 * Puts a chain on a track. replace: the rack becomes the chain; otherwise the chain goes first and the track keeps
 * its other effects (an effect of the same built-in type isn't doubled). makeId() gives each new insert its id.
 */
export function applyChain(tr, chain, makeId, { replace = false, tag = null } = {}) {
  const fresh = chain.map(f => ({ ...JSON.parse(JSON.stringify(f)), id: makeId(), ...(tag ? { [tag]: true } : {}) }));
  if (replace) { tr.fx = fresh; return fresh.length; }
  const types = new Set(fresh.filter(f => f.type !== 'au').map(f => f.type));
  const plugs = new Set(fresh.filter(f => f.type === 'au').map(f => f.plugin));
  const keep = (tr.fx || []).filter(f => (f.type === 'au' ? !plugs.has(f.plugin) : !types.has(f.type)));
  tr.fx = [...fresh, ...keep];
  return fresh.length;
}
