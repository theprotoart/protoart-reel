// HELP: how Reel works, as topics you can search. Type a question or a word ("pause", "claps", "shortcut",
// "plug-in") and the topics that answer it stay, with the words lit. The window scrolls; nothing is cut off.
// Text markup: **bold** and `key`.
import { el, modal } from './ui.js';

export const TOPICS = [
  ['Getting started', 'start begin new project edit record simple full guide', [
    'Press **RECORD MY SCREEN** to record, or **EDIT A VIDEO** to bring in a video you have. **SIMPLE** (top bar) shows the essentials and a 1 → 2 → 3 guide; **FULL** shows every tool.',
    'Turn on **EXPLAIN** (top right) and rest the pointer on anything to see what it does.']],
  ['Recording', 'record rec screen window camera microphone mic computer audio countdown stop pause resume', [
    'Press **REC** (`⌘R`), pick a screen or a window, and choose camera, microphone and computer audio. After the countdown Reel hides.',
    'While recording, the panel at the bottom of the screen has **MARK**, **PAUSE** and **STOP** (`⌥⇧⌘M`, `⌥⇧⌘2`, `⇧⌘2`; also the red icon in the menu bar). A pause is simply left out of the recording.',
    'Each source is saved as its own file (screen and camera as MP4, sound as lossless WAV), so you can edit them separately, like ScreenFlow. A recording’s clips come in **grouped**: move or trim one and the others follow. **UNGROUP** splits them.']],
  ['Takes: clap when a line goes wrong', 'takes take clap claps mistake retake bad keep drop mark marker fluff redo', [
    'Messed up a line? **Clap three times** (or press `⌥⇧⌘M` / **MARK**), pause, and say it again. When you stop, Reel listens to the microphone and splits the recording into takes at each clap.',
    '**✂ TAKES** (top bar, next to REC) lists them. The take before each clap is marked **DROP**; the last one is kept. Play any take with ▶, switch **KEEP / DROP**, then **REMOVE DROPPED TAKES** cuts them, claps and all, and closes the gaps (`⌘Z` brings them back).',
    'For other footage: select a clip and press **LISTEN FOR CLAPS** in TAKES (or Edit › Find Clap Markers…). Settings › Playback & Recording can cut the claps out automatically instead.']],
  ['Editing on the timeline', 'edit cut split splice blade trim delete ripple move snap group ungroup marker select', [
    'Drag media from the left onto the timeline. Upper tracks draw on top. `S` splices at the playhead, `T` is the blade, `⌫` deletes, `⇧⌫` deletes and closes the gap, `M` adds a marker, `Space` plays.',
    'Drag a clip’s edges to trim it; a group (screen + its sound) trims together. `⌥` while trimming moves only that clip, or rolls a cut between two touching clips.',
    '**SNAP** (tool bar) makes clips land flush against each other, markers and the playhead in one move.',
    'The tool bar keeps the editing tools in view; the rest are in **EFFECTS ▾**, **AUDIO ▾**, **TEXT ▾**, **PARTS ▾** and **⚙ ▾**.']],
  ['Auto Edit', 'auto edit automatic tiktok shorts youtube podcast best moments cut ums pauses clean one clip', [
    '**⚡ AUTO EDIT** (`⌥⌘E`) edits a video for TikTok / Reels, Shorts, a podcast clip or YouTube: best moments, cuts ums and long pauses, reframes vertical, adds Smart Zoom, transitions, captions and an even volume. You preview it and choose **KEEP IT**, **DISCARD** or **TRY ANOTHER**.',
    'To use only some parts of a long video, choose **PARTS ▾ › Keep a part** and drag across each part first.',
    '**One clip only:** right-click a clip › **⚡ Auto Edit this clip…** (or Clip › Auto Edit This Clip…). Only that clip (and its group) is processed; the rest of the project isn’t touched.']],
  ['Smart Zoom, actions and effects', 'zoom smart zoom action pan animate transitions presets time-lapse vertical callout arrow text title effects', [
    '**EFFECTS ▾ › Smart Zoom** adds zoom-ins and pans where things move and on the cuts (and follows the pointer on Reel recordings). Auto Edit adds them too when **Zooms** isn’t Off; they show as blue bars on the clip and play in the preview.',
    '**Actions** animate a clip: zoom into part of the screen, pan, fade. Press `⌘K` at the playhead, then move or resize the clip in the preview.',
    'Transitions: click the **⧓** on any cut, or EFFECTS ▾ › Transitions & fades. **Presets** has title animations, motion presets, lower thirds and sound effects with live previews.',
    'Text, callouts (spotlight, blur, magnify) and arrows are in **+ INSERT ▾**.']],
  ['Voice over and ADR', 'voice over voiceover narration record mic punch adr dialogue align guide vocalign lip sync mute', [
    '**AUDIO ▾ › Voice over** (`⇧⌘R`) records your mic while the edit plays, from the playhead. **PUNCH IN** re-records just between In (`I`) and Out (`O`).',
    'The first time, it asks whether to **mute the edit** while you record (so speakers don’t leak into the mic); “Mute the edit” changes it later.',
    '**ADR:** tick “ADR: align each take to the original dialogue” and pick the **Guide** track that holds the original line (like VocALign), or leave it automatic. Each take is lined up syllable by syllable. To align two clips you already have, select both and use AUDIO ▾ › ADR (`⌥⌘A`).']],
  ['Sound, mixer and plug-ins', 'sound audio mixer level volume pan eq plug-in plugin waves izotope fabfilter live render spectral denoise loudness auto level duck', [
    '**MIXER** (`⇧⌘M`) has a strip for every track: level, pan, mute, solo, effects. **+ effect › ★ Your plug-ins** puts an Audio Unit (Waves, iZotope, FabFilter…) on a track.',
    '**Hear a plug-in live:** click it on the strip to open its window, then press `Space`. The LISTEN LIVE bar lets you **RENDER INTO TRACK** (the plug-in is applied to the sound for good, and the strip is freed) or leave it to **render at export** (the default). **CLOSE PLUG-IN** goes back to normal playback; your settings are kept.',
    '**SPECTRAL** (`⌥⌘S`) repairs sound: de-noise, de-click, de-ess, de-bark. **Auto Level** evens out a track’s volume. Music marked “Duck under voice” gets quieter while you talk.']],
  ['Waveforms and sound sync', 'waveform sync latency delay out of sync early late audio buffer interface hear', [
    'Sound reaches your ears a little after it plays (more with a large playback buffer or an audio interface). Reel plays sound clips that much early so what you hear lines up with the playhead and the waveform. If speech still looks early or late against its waveform, set **Settings › Playback & Recording › Sound sync** by hand.']],
  ['Captions and editing by text', 'captions subtitles srt vtt transcript text edit words ums', [
    '**TEXT ▾ › Auto captions** listens to the speech and writes timed captions. Import or export SRT / WebVTT from the File menu; delete them all from the caption lane.',
    '**TEXT ▾ › Edit by text** shows a transcript: delete words to cut them, and remove ums and long pauses.']],
  ['Keyboard shortcuts', 'keyboard shortcut shortcuts keys hotkey custom change assign', [
    '**Settings › Keyboard Shortcuts** lists every command: the editing keys (`S`, `M`, `I`, `O`…) and everything in the menus. Click one and press the keys you want; Reel warns if they’re taken. Clear or reset any of them.',
    'Common ones: `Space` play, `J` `K` `L` shuttle, `←` `→` one frame, `I` / `O` In and Out, `[` `]` trim to the playhead, `⌘Z` undo, `⌘S` save, `⌘E` export.']],
  ['Thumbnails and pictures', 'thumbnail image ernie flux ai picture title youtube', [
    '**THUMBNAIL** (`⌘T`) opens the Thumbnail Studio: start from any frame, paint new art with ERNIE (from a prompt or over the frame) and add a big title. **AI IMAGE** makes a picture for the edit. They run on this Mac through ProtoArt Studio; nothing is uploaded.']],
  ['Exporting', 'export render save video mp4 hevc h264 audio chapters loudness', [
    '**EXPORT** (`⌘E`) renders exactly what the preview shows with Apple’s hardware encoder: H.264 for everywhere, HEVC for smaller files, or audio only. Markers become YouTube chapter text. Plug-ins on tracks are applied at the end.']],
  ['Saving, settings and where things are', 'save saved autosave settings preferences storage folder where projects movies proxy remember', [
    '**SAVE** (top bar, `⌘S`) saves now; the SAVED lamp lights when everything is saved. Reel also saves automatically (Settings › General).',
    'Projects live in Movies › ProtoArt Reel (change it in Settings › Media & Storage), one .reel folder per project with its media inside.',
    'Reel remembers its window, your last recording source and settings, and the size of your last new project. **⚙ ▾ › Proxy** plays smaller copies of big videos so editing stays smooth; export always uses the originals.']],
];

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** **bold** and `key` → elements, with matches of `words` lit. */
function rich(text, words) {
  const out = [];
  const re = /\*\*(.+?)\*\*|`(.+?)`/g;
  let last = 0, m;
  const lit = s => {
    if (!words.length) return [s];
    const parts = s.split(new RegExp(`(${words.map(esc).join('|')})`, 'gi'));
    return parts.map((p, i) => (i % 2 ? el('mark', { text: p }) : p));
  };
  while ((m = re.exec(text))) {
    out.push(...lit(text.slice(last, m.index)));
    out.push(m[1] ? el('b', {}, ...lit(m[1])) : el('kbd', { text: m[2] }));
    last = re.lastIndex;
  }
  out.push(...lit(text.slice(last)));
  return out;
}

/** Topics that answer a question: every word (ignoring little ones) must appear in the topic. */
export function searchTopics(q) {
  const stop = new Set(['how', 'do', 'i', 'the', 'a', 'an', 'to', 'can', 'is', 'my', 'in', 'of', 'what', 'where', 'and', 'or', 'it', 'on', 'for', 'with', 'why', 'does']);
  const words = q.toLowerCase().split(/[^a-z0-9⌘⇧⌥⌫-]+/).filter(w => w && !stop.has(w));
  if (!words.length) return { words: [], hits: TOPICS };
  const hits = TOPICS.map(t => {
    const hay = (t[0] + ' ' + t[1] + ' ' + t[2].join(' ')).toLowerCase();
    const score = words.reduce((n, w) => n + (hay.includes(w) ? 1 + (t[1].includes(w) ? 2 : 0) + (t[0].toLowerCase().includes(w) ? 3 : 0) : -100), 0);
    return [score, t];
  }).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).map(([, t]) => t);
  return { words, hits };
}

export function showAbout() {
  const search = el('input', { type: 'search', class: 'help-search', placeholder: 'Search help: “pause recording”, “claps”, “shortcut”, “plug-in”…' });
  const body = el('div', { class: 'help-body' });
  const draw = () => {
    const { words, hits } = searchTopics(search.value);
    if (!hits.length) { body.replaceChildren(el('p', { class: 'note', text: 'Nothing found. Try another word, or turn on EXPLAIN and rest the pointer on a control.' })); return; }
    body.replaceChildren(...hits.flatMap(([title, , paras]) => [el('h3', {}, ...rich(title, words)), ...paras.map(p => el('p', {}, ...rich(p, words)))]));
    body.scrollTop = 0;
  };
  search.addEventListener('input', draw);
  draw();
  modal('How ProtoArt Reel works', el('div', { class: 'about help' },
    el('p', { class: 'note', text: 'Model PR-1 · a screen recorder and editor in the spirit of ScreenFlow, with ERNIE thumbnails. Everything stays on your Mac.' }),
    search, body), [], { wide: true });
  setTimeout(() => search.focus(), 50);
}
