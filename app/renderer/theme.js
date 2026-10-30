// Light or dark finish (or follow macOS). The gear keeps its look either way: only the faceplate, keys
// and text fields change finish; knobs, meters, lamps and displays stay as they are.
import { installFaceplate } from './gear.js';

const KEY = 'reel.theme';
const mq = () => window.matchMedia?.('(prefers-color-scheme: light)');
export const themeChoice = () => { try { return localStorage.getItem(KEY) || 'dark'; } catch { return 'dark'; } };
export const effectiveTheme = (c = themeChoice()) => (c === 'system' ? (mq()?.matches ? 'light' : 'dark') : c);

export function applyTheme(choice = themeChoice()) {
  const t = effectiveTheme(choice);
  document.documentElement.dataset.theme = t;
  installFaceplate(t === 'light');
  window.app?.timeline?.drawRuler?.(); // the ruler is drawn, not styled
  window.reel?.setTheme?.(choice).catch?.(() => {});
}
export function setTheme(choice) {
  try { localStorage.setItem(KEY, choice); } catch { /* fine */ }
  applyTheme(choice);
}
export function toggleTheme() { setTheme(effectiveTheme() === 'light' ? 'dark' : 'light'); }
mq()?.addEventListener?.('change', () => { if (themeChoice() === 'system') applyTheme(); });
