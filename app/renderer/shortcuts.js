// Keyboard shortcuts you choose (Settings › Keyboard Shortcuts). Two kinds of command can be given keys:
// everything in the menus (File, Edit, Clip…), and the editor's own one-key commands (S splice, M marker, I / O…).
// Your choices are stored by the main process (shortcuts.json); keys with ⌘, ⌃ or ⌥ go on the menu item itself,
// plain keys are handled here, so typing in a text box never sets one off.
import { el, toast, ask } from './ui.js';

/** The editor's own keys (not in the menus). */
export const KEY_COMMANDS = [
  { cmd: 'play-pause', label: 'Play / pause', def: 'Space' },
  { cmd: 'split', label: 'Splice at the playhead', def: 'S' },
  { cmd: 'tool-select', label: 'Select tool', def: 'A' },
  { cmd: 'tool-forward', label: 'Select forward tool (everything to the right)', def: 'Shift+A' },
  { cmd: 'tool-blade', label: 'Blade tool', def: 'T' },
  { cmd: 'delete', label: 'Delete', def: 'Backspace' },
  { cmd: 'ripple-delete', label: 'Ripple delete', def: 'Shift+Backspace' },
  { cmd: 'close-gaps', label: 'Close every gap (remove empty space)', def: 'Alt+Backspace' },
  { cmd: 'marker', label: 'Add marker', def: 'M' },
  { cmd: 'clip-marker', label: 'Add clip marker', def: 'Shift+M' },
  { cmd: 'mark-in', label: 'Set In', def: 'I' },
  { cmd: 'mark-out', label: 'Set Out', def: 'O' },
  { cmd: 'add-section', label: 'Keep In–Out as a part', def: 'X' },
  { cmd: 'clear-inout', label: 'Clear In and Out', def: 'Alt+X' },
  { cmd: 'trim-front', label: 'Trim start to playhead', def: '[' },
  { cmd: 'trim-end', label: 'Trim end to playhead', def: ']' },
  { cmd: 'disable', label: 'Disable / enable clip', def: 'V' },
  { cmd: 'freeze', label: 'Freeze frame', def: 'Alt+F' },
  { cmd: 'shuttle-back', label: 'Shuttle back (J)', def: 'J' },
  { cmd: 'shuttle-stop', label: 'Stop (K)', def: 'K' },
  { cmd: 'shuttle-fwd', label: 'Shuttle forward (L)', def: 'L' },
];
const KEY_BY_CMD = Object.fromEntries(KEY_COMMANDS.map(k => [k.cmd, k]));
const DEFAULT_BY_ACCEL = Object.fromEntries(KEY_COMMANDS.filter(k => k.def).map(k => [k.def, k.cmd]));

const CODE_KEYS = { Space: 'Space', Backspace: 'Backspace', Delete: 'Delete', Tab: 'Tab', Enter: 'Return', NumpadEnter: 'Return', Escape: 'Escape',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`', Equal: '=', Minus: '-', Backslash: '\\' };
/** A key press as an Electron accelerator ("Command+Shift+K"), from the physical key so ⌥ doesn't change it. */
export function accelOf(e) {
  let key = null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (/^F([1-9]|1[0-9]|20)$/.test(e.code)) key = e.code;
  else key = CODE_KEYS[e.code] || null;
  if (!key) return null;
  return [e.metaKey && 'Command', e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', key].filter(Boolean).join('+');
}
const SYM = { Command: '⌘', Control: '⌃', Alt: '⌥', Shift: '⇧', Backspace: '⌫', Delete: '⌦', Return: '↩', Escape: 'Esc', Tab: '⇥', Up: '↑', Down: '↓', Left: '←', Right: '→', Space: 'Space', PageUp: 'Page Up', PageDown: 'Page Down' };
/** "Command+Shift+K" → "⇧⌘K" (macOS order: ⌃⌥⇧⌘). */
export function pretty(a) {
  if (!a) return '—';
  const parts = a.replace('CmdOrCtrl', 'Command').split('+').filter(Boolean);
  const key = parts.pop() || '+';
  const order = ['Control', 'Alt', 'Shift', 'Command'];
  return order.filter(m => parts.includes(m)).map(m => SYM[m]).join('') + (SYM[key] || key);
}
const modded = a => /(^|\+)(Command|Control|Alt)\+/.test(a);

/** Loads your shortcuts (and the menus' list of commands) from the main process. */
export async function loadShortcuts(app) {
  try { const r = await app.api.shortcutsGet(); app.shortcuts = { menu: r.menu || [], own: r.own || {} }; }
  catch { app.shortcuts = { menu: [], own: {} }; }
  return app.shortcuts;
}
/** What a command's key is now (yours, or its default). */
function current(app, cmd, def) { const own = app.shortcuts?.own || {}; return Object.prototype.hasOwnProperty.call(own, cmd) ? own[cmd] : def; }

/** Runs one command by name, including the editor-only ones. */
export function runCommand(app, cmd) {
  const p = app.player, fps = app.doc?.canvas?.fps || 30; void fps;
  switch (cmd) {
    case 'play-pause': if (app.shuttle) { app.stopShuttle(); p.pause(); } else p.toggle(); return;
    case 'tool-select': app.timeline.setTool('select'); return;
    case 'tool-forward': app.timeline.setTool('forward'); return;
    case 'tool-blade': app.timeline.setTool(app.timeline.tool === 'blade' ? 'select' : 'blade'); return;
    case 'shuttle-back': if (p.playing || app.shuttle) app.shuttleStep(-1); else app.seek(p.time - 5); return;
    case 'shuttle-fwd': if (p.playing || app.shuttle) app.shuttleStep(1); else app.seek(p.time + 5); return;
    case 'shuttle-stop': app.stopShuttle(); p.pause(); return;
    default: app.cmd(cmd);
  }
}

/**
 * Called first by the editor's key handler. Returns true when the press was yours to handle (a key you gave a
 * command, or a default key you moved elsewhere, which then does nothing).
 */
export function handleShortcutKey(app, e) {
  const own = app.shortcuts?.own;
  if (!own) return false;
  const acc = accelOf(e);
  if (!acc) return false;
  for (const [cmd, a] of Object.entries(own)) {
    if (a !== acc) continue;
    // a key with ⌘ / ⌃ / ⌥ on a menu command is run by the menu itself
    if (modded(a) && (app.shortcuts.menu || []).some(m => m.cmd === cmd)) return false;
    e.preventDefault();
    if (!e.repeat || cmd === 'play-pause') runCommand(app, cmd);
    return true;
  }
  const def = DEFAULT_BY_ACCEL[acc];
  if (def && Object.prototype.hasOwnProperty.call(own, def) && own[def] !== acc) return true; // moved away: the old key is free
  return false;
}

/** The Settings page: every command, its key, click to record a new one. */
export function shortcutsPage(app) {
  const box = el('div', { class: 'keys-page' });
  const search = el('input', { type: 'search', placeholder: 'Search commands…', class: 'keys-search' });
  const list = el('div', { class: 'keys-list' });
  const resetAll = el('button', { class: 'hw', text: 'RESET ALL TO DEFAULTS' });
  box.append(el('p', { class: 'note', text: 'Click a shortcut, then press the keys you want (Esc cancels). ⌫ on its own works too: it becomes the shortcut. Keys with ⌘, ⌃ or ⌥ also show in the menus.' }),
    el('div', { class: 'row' }, search, resetAll), list);
  let capturing = null;
  const all = () => {
    const menu = (app.shortcuts?.menu || []).map(m => ({ ...m, group: m.menu || 'Menus' }));
    return [...KEY_COMMANDS.map(k => ({ ...k, group: 'Editing keys' })), ...menu.filter(m => !KEY_BY_CMD[m.cmd])];
  };
  const save = async own => {
    try { const clean = await app.api.shortcutsSet(own); app.shortcuts.own = clean; } catch (e) { toast(`Couldn’t save shortcuts: ${e.message}`, 5000); }
    draw();
  };
  const assign = async (item, acc) => {
    const own = { ...(app.shortcuts.own || {}) };
    const clash = all().find(x => x.cmd !== item.cmd && current(app, x.cmd, x.def) === acc);
    if (clash) {
      const ok = await ask('Shortcut already used', `${pretty(acc)} is the shortcut for “${clash.label}”. Give it to “${item.label}” instead? “${clash.label}” will have no shortcut.`, 'Use it here');
      if (!ok) return draw();
      own[clash.cmd] = '';
    }
    own[item.cmd] = acc === item.def ? undefined : acc;
    if (own[item.cmd] === undefined) delete own[item.cmd];
    await save(own);
    toast(`${item.label}: ${pretty(acc)}`);
  };
  const stopCapture = () => {
    if (!capturing) return;
    window.removeEventListener('keydown', capturing.onKey, true);
    app.api.shortcutsCapture?.(false);
    capturing = null;
  };
  const startCapture = (item, btn) => {
    stopCapture();
    btn.textContent = 'Press keys…'; btn.classList.add('listening');
    app.api.shortcutsCapture?.(true); // the menus' own shortcuts stay quiet while you press keys
    const onKey = e => {
      e.preventDefault(); e.stopPropagation();
      if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return;
      if (e.code === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) { stopCapture(); draw(); return; }
      const acc = accelOf(e);
      if (!acc) { toast('That key can’t be used as a shortcut.'); return; }
      stopCapture();
      if (!KEY_BY_CMD[item.cmd] && !modded(acc) && /^[A-Z0-9]$|^Shift\+[A-Z0-9]$/.test(acc)) toast('A single letter only works while the timeline has focus, not while typing.', 4000);
      assign(item, acc);
    };
    capturing = { onKey };
    window.addEventListener('keydown', onKey, true);
  };
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const items = all().filter(x => !q || x.label.toLowerCase().includes(q) || x.group.toLowerCase().includes(q) || pretty(current(app, x.cmd, x.def)).toLowerCase().includes(q));
    const groups = [...new Set(items.map(x => x.group))];
    list.replaceChildren(...groups.flatMap(g => [
      el('div', { class: 'engr keys-group', text: g }),
      ...items.filter(x => x.group === g).map(x => {
        const cur = current(app, x.cmd, x.def), changed = cur !== x.def;
        const btn = el('button', { class: 'key-cap' + (changed ? ' changed' : ''), text: pretty(cur), title: 'Click, then press the new shortcut' });
        btn.addEventListener('click', () => startCapture(x, btn));
        return el('div', { class: 'key-row' },
          el('span', { class: 'key-label', text: x.label }), btn,
          el('button', { class: 'mini', text: '×', title: 'No shortcut', onclick: () => { const own = { ...app.shortcuts.own, [x.cmd]: '' }; save(own); } }),
          changed ? el('button', { class: 'mini', text: '↺', title: `Back to ${pretty(x.def)}`, onclick: () => { const own = { ...app.shortcuts.own }; delete own[x.cmd]; save(own); } }) : el('span', { class: 'mini-gap' }));
      }),
    ]));
  };
  search.addEventListener('input', draw);
  resetAll.addEventListener('click', async () => { if (await ask('Reset all shortcuts?', 'Every command goes back to the shortcut it came with.', 'Reset')) save({}); });
  loadShortcuts(app).then(draw);
  draw();
  box._cleanup = stopCapture;
  return box;
}
