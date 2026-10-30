// "How Reel works" card.
import { el, modal } from './ui.js';

export function showAbout() {
  const k = s => el('kbd', { text: s });
  modal('How ProtoArt Reel works', el('div', { class: 'about' },
    el('p', { text: 'Model PR-1 · a screen recorder and editor in the spirit of ScreenFlow, with ERNIE thumbnails. Everything stays on your Mac.' }),
    el('h3', { text: '1 · Record' }),
    el('p', {}, 'Press ', el('b', { text: 'REC' }), ', pick a screen or a window, and choose camera, microphone and computer audio. After a 3-second countdown Reel hides; stop with ', k('⇧⌘2'), ' or the red icon in the menu bar. Each source is saved as its own file (screen and camera as H.264 MP4, sound as lossless WAV), so you can edit them separately, just like ScreenFlow. The pointer position is recorded too.'),
    el('h3', { text: '2 · Edit' }),
    el('ul', {},
      el('li', {}, 'Drag media from the left onto the timeline. Upper tracks draw on top. ', k('S'), ' splits, ', k('⌫'), ' deletes, ', k('⇧⌫'), ' deletes and closes the gap, ', k('M'), ' adds a marker, ', k('Space'), ' plays.'),
      el('li', {}, 'Drag a clip’s edges to trim it. Drag it in the preview to move it; drag the corner to resize. Presets put the camera in a corner as picture-in-picture.'),
      el('li', {}, el('b', { text: 'Actions' }), ' animate a clip — zoom into part of the screen, pan, fade. Press ', k('⌘K'), ' at the playhead, then move/resize the clip; blue bars on the clip show each action. ', el('b', { text: 'Auto zoom' }), ' makes them for you from the recorded pointer.'),
      el('li', {}, el('b', { text: 'Text' }), ', ', el('b', { text: 'callouts' }), ' (spotlight, blur or magnify an area) and ', el('b', { text: 'arrows' }), ' sit on their own tracks. Transitions (fade, dip, slide, zoom, pop, blur) are set per clip.'),
      el('li', {}, 'Audio: volume, fades, mute per clip or track. Mark narration as ', el('b', { text: 'Voice' }), ' and music with “Duck under voice” gets quieter while you talk.')),
    el('h3', { text: 'Sound' }),
    el('p', {}, 'When recording, Computer audio can be ', el('b', { text: 'All sound' }), ' or ', el('b', { text: 'Chosen apps' }), ' — each app gets its own track (like Loopback). The ', el('b', { text: 'SOUND' }), ' button opens a per-app mixer (like SoundSource): volume up to 400%, mute, EQ and which speakers each app plays through. No driver is installed; it uses macOS’s own audio taps.'),
    el('h3', { text: '3 · Thumbnail' }),
    el('p', {}, 'Open the ', el('b', { text: 'Thumbnail Studio' }), ' (', k('⌘T'), '). Start from any frame, paint new art with ', el('b', { text: 'ERNIE-Image Turbo' }), ' — from a prompt, or over the frame — and add a big title. ', el('b', { text: 'Suggest prompt' }), ' writes the prompt from your title. ERNIE runs on this Mac through Protoart Studio’s fast engine; nothing is uploaded. Saves 1280×720 PNG or JPG (YouTube’s size).'),
    el('h3', { text: '4 · Export' }),
    el('p', {}, el('b', { text: 'EXPORT' }), ' (', k('⌘E'), ') renders exactly what the preview shows with Apple’s hardware encoder: H.264 for everywhere, HEVC for smaller files, or audio only. Markers become YouTube chapter text.'),
    el('h3', { text: 'Where things are' }),
    el('p', { text: 'Projects live in Movies › ProtoArt Reel, one .reel folder per project with its media inside. Reel saves automatically every minute while you edit.' }),
  ));
}
