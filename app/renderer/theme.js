// Light or dark finish (or follow macOS). The gear keeps its look either way: only the faceplate, keys
// and text fields change finish; knobs, meters, lamps and displays stay as they are.
import { installFaceplate } from './gear.js';

// Colour schemes, the same five as ProtoArt Dandelion (and the ProtoArt Studio rack skin). Each comes in the Light
// or Dark faceplate above. The scheme sets the faceplate metal, the lettering, and the lit colour of keys and lamps.
// Amber is Reel's original look, so it changes nothing.
export const SKINS = {
  amber: { name: 'Amber', hint: 'Charcoal and amber, the classic look',
    lit: [0xfff1c4, 0xffbf55, 0xee9222, 0x2a1600], glow: [255, 160, 30], amber: 0xffae2b,
    metal: { dark: [40, 41, 44], light: [204, 202, 198] }, text: { dark: 0xefeadc, light: 0x16171a }, ink: { dark: 0xf3b552, light: 0x763a00 } },
  powder: { name: 'Powder', hint: 'Powder coat: blue on the Light faceplate, burnt orange on the Dark one; white printing, yellow lamps',
    lit: [0xfffbe0, 0xf6e35a, 0xd9b52a, 0x2a2300], glow: [255, 228, 90], amber: 0xffd84a,
    metal: { dark: [196, 88, 34], light: [90, 140, 230] }, text: { dark: 0xf7f8fc, light: 0xf7f8fc }, ink: { dark: 0xffe45c, light: 0xffe45c }, powder: true },
  cream: { name: 'Cream', hint: 'Warm cream, yellow lamps, deep red',
    lit: [0xfff8de, 0xffd36b, 0xe0a02a, 0x2b1a00], glow: [255, 196, 80], amber: 0xffc94a,
    metal: { dark: [54, 47, 40], light: [224, 213, 192] }, text: { dark: 0xf1e9d6, light: 0x1f1a14 }, ink: { dark: 0xffc94a, light: 0x7a2c1f } },
  slate: { name: 'Slate', hint: 'Blue-grey steel, ivory lamps',
    lit: [0xfffdf3, 0xf1e2b4, 0xcdb57a, 0x26200f], glow: [255, 232, 170], amber: 0xffe7ad,
    metal: { dark: [46, 54, 64], light: [180, 190, 199] }, text: { dark: 0xe8edf1, light: 0x121820 }, ink: { dark: 0xcfe0ec, light: 0x1f4d68 } },
  ember: { name: 'Ember', hint: 'Black and red-orange',
    lit: [0xffdcc6, 0xff7d42, 0xd63c14, 0x280700], glow: [255, 84, 34], amber: 0xff6a2c,
    metal: { dark: [26, 21, 21], light: [196, 186, 182] }, text: { dark: 0xeee3df, light: 0x1b1212 }, ink: { dark: 0xff7d42, light: 0x8a2306 } },
};
const SKIN_KEY = 'reel.skin';
export const skinChoice = () => { try { const v = localStorage.getItem(SKIN_KEY); return SKINS[v] ? v : 'amber'; } catch { return 'amber'; } };

const rgb = n => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
const hex = a => '#' + a.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const scale = (a, k) => a.map(v => v * k);
const VARS = ['--bg', '--panel', '--panel-2', '--panel-3', '--text', '--text-dim', '--text-faint', '--engrave', '--paint', '--ink',
  '--amber', '--amber-glow', '--lit-hi', '--lit-hi2', '--lit-hi3', '--lit-mid', '--lit-lo', '--lit-ink', '--lit-ink2', '--amber2', '--amber3',
  '--glow-a', '--glow-b', '--glow-c', '--glow-d', '--glow-e', '--glow-f', '--glow-g', '--glow-h'];

/** The CSS variables for a scheme on a faceplate (none for Amber: the style sheets already are Amber). */
export function skinVars(id, light) {
  const k = SKINS[id];
  if (!k || id === 'amber') return {};
  const m = k.metal[light ? 'light' : 'dark'], text = rgb(k.text[light ? 'light' : 'dark']), ink = rgb(k.ink[light ? 'light' : 'dark']);
  const [hi, mid, lo, litInk] = k.lit.map(rgb), am = rgb(k.amber), g = k.glow;
  // panels from the faceplate metal: a powder coat keeps its colour (white printing on it); otherwise the
  // same steps as Reel's own dark and light finishes
  const steps = k.powder ? [0.78, 0.86, 0.94, 1.02] : light ? [1.065, 1.11, 1.05, 0.985] : [0.45, 0.62, 0.78, 0.95];
  const [bg, p1, p2, p3] = steps.map(f => hex(scale(m, f)));
  const t = text.join(',');
  const glow = (f, d) => mix(g, f > 0 ? [255, 255, 255] : [0, 0, 0], Math.abs(f)).map(Math.round).join(',') + (d || '');
  return {
    '--bg': bg, '--panel': p1, '--panel-2': p2, '--panel-3': p3,
    '--text': hex(text), '--text-dim': `rgba(${t},0.62)`, '--text-faint': `rgba(${t},0.38)`, '--engrave': `rgba(${t},0.88)`,
    '--ink': hex(ink),
    '--amber': hex(am), '--amber2': hex(am), '--amber3': hex(mix(am, lo, 0.4)), '--amber-glow': `rgba(${g.join(',')},0.75)`,
    '--lit-hi': hex(hi), '--lit-hi2': hex(mix(hi, mid, 0.55)), '--lit-hi3': hex(mix(hi, mid, 0.7)), '--lit-mid': hex(mid), '--lit-lo': hex(lo),
    '--lit-ink': hex(litInk), '--lit-ink2': hex(scale(litInk, 0.7)),
    '--glow-a': glow(0), '--glow-b': glow(0.05), '--glow-c': glow(-0.05), '--glow-d': glow(0.25), '--glow-e': glow(0),
    '--glow-f': glow(-0.15), '--glow-g': glow(0), '--glow-h': glow(-0.25),
  };
}
/** The faceplate metal for a scheme, or null for Reel's own (Amber). */
export const skinMetal = (id, light) => (SKINS[id] && id !== 'amber' ? SKINS[id].metal[light ? 'light' : 'dark'] : null);

export function applySkin(id = skinChoice(), light = effectiveTheme() === 'light') {
  const root = document.documentElement, vars = skinVars(id, light);
  root.dataset.skin = id;
  for (const v of VARS) root.style.removeProperty(v);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  installFaceplate(light, skinMetal(id, light));
}
export function setSkin(id) {
  try { localStorage.setItem(SKIN_KEY, id); } catch { /* fine */ }
  applySkin(id);
  window.app?.timeline?.drawRuler?.();
}

const KEY = 'reel.theme';
const mq = () => window.matchMedia?.('(prefers-color-scheme: light)');
export const themeChoice = () => { try { return localStorage.getItem(KEY) || 'dark'; } catch { return 'dark'; } };
export const effectiveTheme = (c = themeChoice()) => (c === 'system' ? (mq()?.matches ? 'light' : 'dark') : c);

export function applyTheme(choice = themeChoice()) {
  const t = effectiveTheme(choice);
  document.documentElement.dataset.theme = t;
  applySkin(skinChoice(), t === 'light');
  window.app?.timeline?.drawRuler?.(); // the ruler is drawn, not styled
  window.reel?.setTheme?.(choice).catch?.(() => {});
}
export function setTheme(choice) {
  try { localStorage.setItem(KEY, choice); } catch { /* fine */ }
  applyTheme(choice);
}
export function toggleTheme() { setTheme(effectiveTheme() === 'light' ? 'dark' : 'light'); }
mq()?.addEventListener?.('change', () => { if (themeChoice() === 'system') applyTheme(); });
