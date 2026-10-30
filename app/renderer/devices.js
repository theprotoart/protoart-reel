// Audio devices with their real names (Scarlett Solo, AirPods, MacBook Speakers…). macOS shows device
// names only to apps allowed to use the microphone, so this asks for that permission first. Each rebuild
// of Reel is a "new" app to macOS, so the permission may need giving again after a rebuild.
let unlocked = false;
const api = () => window.reel;

/** 'granted' | 'not-determined' | 'denied' | 'restricted' | 'unknown' */
export async function micPermission() {
  try { return (await api().permissions()).microphone || 'unknown'; } catch { return 'unknown'; }
}

export async function audioDevices() {
  let list = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  let permission = 'granted';
  if (!unlocked && list.some(d => (d.kind === 'audioinput' || d.kind === 'audiooutput') && !d.label)) {
    permission = await micPermission();
    if (permission === 'not-determined') { try { permission = (await api().askAccess('microphone')) ? 'granted' : 'denied'; } catch { /* no prompt */ } }
    // ask Chromium itself even when macOS's answer looks like "no": the status read for a freshly rebuilt
    // (re-signed) app can lag behind, and opening the mic for a moment is what reveals the names
    {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach(t => t.stop());
        unlocked = true; permission = 'granted';
        list = await navigator.mediaDevices.enumerateDevices();
      } catch { permission = 'denied'; }
    }
  }
  const named = list.some(d => d.kind === 'audioinput' && d.label);
  const clean = kind => list.filter(d => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications')
    .map((d, i) => ({ id: d.deviceId, name: d.label || (kind === 'audioinput' ? `Input ${i + 1}` : `Output ${i + 1}`) }));
  const def = kind => list.find(d => d.kind === kind && d.deviceId === 'default')?.label?.replace(/^Default - /, '') || '';
  return { inputs: clean('audioinput'), outputs: clean('audiooutput'), defaultInput: def('audioinput'), defaultOutput: def('audiooutput'), needsPermission: !named, permission };
}

/** Fills a <select> with devices; '' = follow the Mac's setting. */
export function fillSelect(sel, devs, current, defName, systemLabel) {
  sel.replaceChildren(new Option(defName ? `${systemLabel} (${defName})` : systemLabel, ''), ...devs.map(d => new Option(d.name, d.id, false, d.id === current)));
  sel.value = devs.some(d => d.id === current) ? current : '';
}

/**
 * A small "Allow microphone" note with a button to the right System Settings page, shown when macOS
 * hasn't let Reel use the microphone (device names stay hidden until it has). Returns an element.
 */
export function permissionNote(onRetry, { short = false } = {}) {
  const box = document.createElement('div');
  box.className = 'mic-perm hidden';
  const text = document.createElement('span');
  text.textContent = short ? 'Allow the microphone to see device names.' : 'macOS hasn’t let Reel use the microphone, so device names (like Scarlett Solo) are hidden. Turn ProtoArt Reel on under Privacy & Security › Microphone, then come back.';
  if (short) box.title = 'macOS hasn’t let Reel use the microphone, so device names (like Scarlett Solo) are hidden. OPEN turns it on under Privacy & Security › Microphone; come back afterwards.';
  const open = document.createElement('button'); open.className = 'tool'; open.textContent = short ? 'OPEN' : 'OPEN SETTINGS';
  open.addEventListener('click', () => api().openPrivacy('microphone'));
  const again = document.createElement('button'); again.className = 'tool'; again.textContent = short ? 'RETRY' : 'TRY AGAIN';
  again.addEventListener('click', () => { unlocked = false; onRetry?.(); });
  if (short) box.classList.add('short');
  const row = document.createElement('div'); row.className = 'mic-perm-btns'; row.append(open, again);
  box.append(text, row);
  box.update = d => box.classList.toggle('hidden', !d.needsPermission);
  return box;
}

export const recSettings = () => { try { return JSON.parse(localStorage.getItem('rec-settings') || '{}') || {}; } catch { return {}; } };
export const setMic = id => { try { localStorage.setItem('rec-settings', JSON.stringify({ ...recSettings(), micId: id })); } catch { /* fine */ } };
