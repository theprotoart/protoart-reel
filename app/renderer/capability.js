// What this Mac can comfortably do. Reel is built to run on an 8 GB M1; a few options need more memory
// (or a newer macOS). Those stay visible but greyed out, with the reason, on Macs that can't run them well,
// and are there for Macs that can. Settings › This Mac lists them and can unlock them anyway.

export const FEATURES = {
  recFull: { name: 'Record above 4K (full resolution of 5K / 6K displays)', ram: 16 },
  rec4k60: { name: 'Record 60 fps at 4K or above', ram: 16 },
  matteAccurate: { name: 'Background removal: Accurate quality', ram: 16 },
  stretchLong: { name: 'Pitch-kept speed changes on clips over 10 minutes, in the export', ram: 16 },
  perAppAudio: { name: 'Per-app sound (MAC APPS in the mixer, chosen apps when recording)', macos: '14.2' },
};

let machine = { ram: 8, chip: '', macos: '', model: '' };
const unlocked = () => { try { return localStorage.getItem('reel.unlockHeavy') === '1'; } catch { return false; } };
export const setUnlocked = on => { try { localStorage.setItem('reel.unlockHeavy', on ? '1' : '0'); } catch { /* fine */ } };
export const isUnlocked = unlocked;

export async function loadMachine(api) {
  try { const m = await api.machineInfo(); if (m && m.ram) machine = m; } catch { /* keep the safe guess */ }
  return machine;
}
export const thisMac = () => machine;

const vers = v => String(v || '0').split('.').map(Number);
const atLeast = (have, need) => { const a = vers(have), b = vers(need); for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0); } return true; };

/** { ok, why, hard } for a feature. hard: can't be unlocked (the OS lacks it). */
export function can(id) {
  const f = FEATURES[id]; if (!f) return { ok: true, why: '' };
  if (f.macos && machine.macos && !atLeast(machine.macos, f.macos)) return { ok: false, hard: true, why: `Needs macOS ${f.macos} or newer (this Mac has ${machine.macos}).` };
  if (f.ram && machine.ram < f.ram - 0.5) {
    if (unlocked()) return { ok: true, why: '', stretched: true };
    return { ok: false, why: `Needs a Mac with ${f.ram} GB of memory or more (this one has ${Math.round(machine.ram)} GB). Settings › This Mac can unlock it anyway.` };
  }
  return { ok: true, why: '' };
}

/** Greys out a button or menu option the Mac can't run well, explaining why. */
export function gate(node, id) {
  const r = can(id);
  if (r.ok) return node;
  node.classList?.add('gated');
  if (node.tagName === 'OPTION') { node.disabled = true; node.textContent += ` — ${FEATURES[id].ram ? `needs ${FEATURES[id].ram} GB` : `needs macOS ${FEATURES[id].macos}`}`; }
  else { node.disabled = true; node.setAttribute('aria-disabled', 'true'); }
  node.title = r.why;
  return node;
}
