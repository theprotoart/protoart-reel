// Floating recording panel: MARK drops a marker, counts the time recorded (not the pauses), PAUSE / RESUME, STOP ends the recording.
const out = document.getElementById('time');
const pauseBtn = document.getElementById('pause');
const pad = n => String(n).padStart(2, '0');
let base = 0, since = Date.now(), paused = false; // recorded ms = base + (paused ? 0 : now - since)
const show = () => {
  if (document.body.classList.contains('between')) return; // counting down to a new take
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
  markBtn.querySelector('.lbl').textContent = n ? `MARK ${n}` : 'MARK';
  if (!n) return;
  markBtn.classList.remove('flash'); void markBtn.offsetWidth; markBtn.classList.add('flash');
});

// RETAKE: the first press arms it (SURE?), a second press within 3 s throws this take away and starts a new one
const retakeBtn = document.getElementById('retake');
let armT = 0;
const disarm = () => { clearTimeout(armT); retakeBtn.classList.remove('arm'); retakeBtn.querySelector('.lbl').textContent = 'RETAKE'; };
retakeBtn.addEventListener('click', () => {
  if (!retakeBtn.classList.contains('arm')) {
    retakeBtn.classList.add('arm'); retakeBtn.querySelector('.lbl').textContent = 'SURE?';
    armT = setTimeout(disarm, 3000);
    return;
  }
  disarm(); retakeBtn.disabled = true;
  window.hud.discard();
});
// the take was thrown away: count down to the new one (the next REC resets the clock)
window.hud.onRetake(n => {
  document.body.classList.add('between');
  document.getElementById('state').textContent = 'NEW TAKE';
  let k = n;
  const tick = () => {
    out.textContent = k > 0 ? `in ${k}` : 'GO';
    if (k-- > 0) setTimeout(tick, 1000);
    else { document.body.classList.remove('between'); document.getElementById('state').textContent = 'REC'; retakeBtn.disabled = false; }
  };
  tick();
});
