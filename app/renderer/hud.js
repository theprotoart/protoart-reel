// Floating recording panel: counts up from when it opened, STOP ends the recording.
const t0 = Date.now();
const out = document.getElementById('time');
const pad = n => String(n).padStart(2, '0');
setInterval(() => {
  const s = Math.floor((Date.now() - t0) / 1000);
  out.textContent = s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}, 250);
document.getElementById('stop').addEventListener('click', () => { document.getElementById('stop').disabled = true; window.hud.stop(); });
