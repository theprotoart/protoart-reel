// Floating recording panel: MARK drops a marker, counts the time recorded (not the pauses), PAUSE / RESUME, STOP ends the recording.
const out = document.getElementById('time');
const pauseBtn = document.getElementById('pause');
const pad = n => String(n).padStart(2, '0');
let base = 0, since = Date.now(), paused = false; // recorded ms = base + (paused ? 0 : now - since)
const show = () => {
  const s = Math.floor((base + (paused ? 0 : Date.now() - since)) / 1000);
  out.textContent = s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
};
setInterval(show, 250);
window.hud.onPaused((p, recordedMs) => {
  paused = p; base = recordedMs; since = Date.now();
  document.body.classList.toggle('paused', p);
  document.getElementById('state').textContent = p ? 'PAUSED' : 'REC';
  pauseBtn.querySelector('.lbl').textContent = p ? 'RESUME' : 'PAUSE';
  pauseBtn.title = p ? 'Resume recording (⌥⇧⌘2)' : 'Pause recording (⌥⇧⌘2). Nothing is recorded until you resume.';
  pauseBtn.disabled = false;
  show();
});
pauseBtn.addEventListener('click', () => { pauseBtn.disabled = true; window.hud.pause(); setTimeout(() => { pauseBtn.disabled = false; }, 1500); });
document.getElementById('stop').addEventListener('click', () => { document.getElementById('stop').disabled = true; window.hud.stop(); });
const markBtn = document.getElementById('mark');
markBtn.addEventListener('click', () => window.hud.mark());
window.hud.onMarked(n => {
  markBtn.querySelector('.lbl').textContent = `MARK ${n}`;
  markBtn.classList.remove('flash'); void markBtn.offsetWidth; markBtn.classList.add('flash');
});
