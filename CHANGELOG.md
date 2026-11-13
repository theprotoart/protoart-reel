# Changelog

## 1.7.0 — Style packs, film cuts and Randomize

- **🎬 Style packs**: a whole look in one click, with live previews: **Nature Documentary**, **Fizz Commercial**,
  **Movie Trailer**, **Retro VHS**, **Sports Highlight**, **Travel Vlog** and **Breaking News**.
  - Each sets the transitions on every cut, a colour look (with grain or letterbox), camera moves, titles and title
    cards, graphics, and sound effects.
  - Optionally it snaps the cuts to the music's beat, as roll edits so nothing else moves.
  - Applying another style replaces it. **Remove style** takes it off; ⌘Z undoes it.
- New graphics, used by the packs and also in Presets › Elements:
  - a documentary lower third with a gold rule;
  - a typed location stamp;
  - a map pin and a travel route map with a moving plane;
  - fizz bubbles, the VHS screen (tracking lines, PLAY ▶, date and tape counter);
  - a score bug, a replay badge, and a news ticker.
- New sound: **Tape stop**.
- **✂ Film cuts** (a key on the right, Presets › FILM CUTS, Clip › Film Cuts):
  - **L-cut**, **J-cut**, **Smash cut**, **Jump cut** (with punch-in), **Cut on action**, **Cutaway / insert** and
    **Cross-cut** (two scenes turn about, ever faster).
  - **⚡ Auto L & J cuts** puts them, taking turns, on every cut between clips with sound.
  - The L / J sound overlap is adjustable (0.5–3 s).
- **🎲 Randomize** for transitions on every cut (Auto packs, style packs, Settings › Timeline): from "in order"
  through "same feel" to "surprise me", with lengths varied a little too.

## 1.6.3 — Eight more transitions

- In the transition presets, the ⧓ picker on every cut and the clip's Transitions:
  - **Fast wipe**: a hard, quick sweep with a bright slanted edge.
  - **Glitch blocks**: pieces of the picture jump sideways and flash in colour.
  - **Warp zoom**: rushes into one point of the frame; the next shot zooms back out from it.
  - **Slide + shake** (like CapCut): the new shot pushes the old one off, then lands with a quick shake.
  - **Vintage film burn**: burning holes, projector flicker, grain and faded colour.
  - **Movement match cut**: both shots keep moving the same way and hand over mid-move.
  - **Graphic match cut**: the shots' middles line up and the old one melts into the new.
  - **Vertigo ramp**: a dolly zoom that speeds up; the middle holds still while the edges rush in.
- Fast wipe, Slide + shake and the two match cuts show both shots at once, so they use a little of each clip past
  the cut (like a crossfade).
- Auto Edit packs: **Trending** (slide + shake, fast wipes, warp zooms, glitch blocks) and **Vintage**.

## 1.6.2 — Radial shutter transition

- **Radial shutter** (a camera's iris), in the transition presets, the ⧓ picker on every cut and the clip's
  Transitions: seven metal blades turn and close over the clip going out until they meet in the middle, then open
  on the next clip. With sounds on, it gets a camera shutter click.

## 1.6.1 — Isolate or remove a sound by describing it

- **👻 Isolate a sound** (AUDIO ▾, right-click a clip, or the AUDIO tab in the panel on the right): type what you hear
  ("dog barking", "keyboard typing", "music", "voice") and Reel pulls just that sound out of the clip, or takes it
  out and keeps everything else. The result goes on a new track under the clip, in step and grouped with it, and the
  clip's own sound is muted (unmute it to compare; ⌘Z undoes). The idea of AudioGhost AI, using Meta's SAM-Audio
  on this Mac's graphics chip through mlx-audio (AudioGhost itself needs an NVIDIA card). One-time GET: Small
  (any Apple silicon Mac, about 2 GB) or Large (32 GB Macs, about 7 GB); then offline, nothing uploaded. Fast or
  Best quality; long clips are done in 10-second parts with a progress bar.

## 1.6.0 — Two lines of work together: clap notes, colour match, retime, fit music, voices

Brings together the two versions that were both called 1.5.9: the one with Kitten voices (released as 1.5.9 and
1.5.10, below) and the one with clap notes, colour match, retime and fit music (these notes). Plus:

- **Fade curves, like Audition**: drag a clip's fade handle (top corner) sideways for its length and up or down to
  curve it: from a fast start (rises early, smooth on music) through straight to a slow start. The shape is drawn
  on the clip and heard the same in playback and export; double-click the handle for a straight fade again. Also
  Fade in / out curve sliders in the AUDIO tab.
- **🎵 REMIX switch** next to SNAP (like Audition's Remix): on, the right end of any music or sound clip is the ♪,
  so dragging it makes the song longer or shorter seamlessly; off, the end trims the clip as normal. Remembered.
- **The panel on the right opens on the tab for what you select**: AUDIO for a sound clip, VIDEO for a video or a
  picture (ALL for a mix). A tab you pick by hand stays while the same clips are selected.
- **Fix: renaming a project** from its title now renames its folder too (when you close it or quit), so the
  Projects screen shows the new name.
- **Right-click menus** no longer show runs of empty divider lines.
- **🎵 Fit music to a length** (seamless music extension, like DaVinci Resolve): select the music › the **MUSIC** tab in
  the panel on the right (🎵 FIT TO THE VIDEO in one click), or AUDIO ▾ › Fit music to a length…, and choose the end of the video, the In–Out or a length you type. Reel finds the beat and where the
  song repeats itself, and plays a section again (or skips one) right there with short crossfades, so the join can't
  be heard; the intro and the real ending stay. The last fraction of a second is made up with a pitch-kept speed
  change of at most 3%. Or **drag the ♪ on the end of a music clip** to where the music should stop (it snaps to the end of the
  video): on release the song is re-fitted to that length, longer or shorter, again and again from its original source.
  The result is ordinary grouped clips (move a join, or ⌘Z).
- **〰 Elastic Wave** (like Fairlight's): right-click an audio clip › Elastic Wave, press on the waveform and drag (or
  double-click to drop a marker on a word or beat, and drag that): the sound on each side stretches or squeezes to meet it, pitch kept, the ends pinned.
  Each part shows its speed.
- **⤳ Retime curve** in the inspector: clip time across, source time up; drag points or press anywhere on the line
  and drag, double-click to add or remove,
  presets Ease in, Ease out, Speed ramp, Slow-mo middle and Straight. Picture and sound follow it in the preview and
  the export (sound pitch-kept with the same WSOLA stretch as speed changes; Keep pitch off gives a tape sound).
  Splits, trims, rolling edits and speed changes keep a clip's timing map in step.

- **Notes on screen with a clap** (cooking, crafts, tutorials). Clap, then say what should appear on screen:
  “Ingredients: two eggs, a cup of flour and a pinch of salt.” AUTO EDIT › Claps › **Show as notes** turns each
  clap into a note card (a title and a list that comes in one item at a time) with what you said, and cuts the claps
  out. Notes: **Keep what I say**, or **Cut what I say** so it only shows as text. Also in Find clap markers…
  (📝 Make on-screen notes). The card's list is editable in the inspector, one item per line.
- **Picture in picture is easy to find:** a **▣ PiP** key on the tool strip, and **PICTURE IN PICTURE** corners
  (↖ ↗ ↙ ↘, FULL) at the top of the inspector for any video or picture. A PiP clip under a full-frame video
  moves to a track of its own on top, so it always shows.
- **Text reveal transition:** the next clip plays through big bold words over the one before, then the words zoom
  into a letter until the new clip fills the screen. Type the words in Transitions › Reveal text.
- **Thumbnails from a frame of the video:** right-click the preview › Use this frame for the thumbnail…, or pick
  from the best-looking frames Thumbnail Studio finds (★ the sharpest, most colourful one), step a frame or a
  second at a time, and give it **Pop**. No AI art needed.
- **🎨 Match colour:** make clips look like a reference shot (the same warmth, brightness and contrast), measured
  on a few frames on this Mac; the selected clips or every clip, with an Amount. **◐ Colour wheels** for
  shadows, midtones and highlights (lift, gamma, gain). Both run on the graphics chip, in preview and export.
- **Transform handles like DaVinci Resolve:** round handles on the corners and sides, a **rotation handle** on a
  stem above the picture (⇧ for 15° steps; straight is sticky; double-click to straighten), and a centre dot
  (double-click to centre). The box turns with a rotated picture, and resizing follows its sides.
- **Proxy media & render cache settings** (Settings › Media & Storage, like an editor's optimized media and render
  cache page): proxies Automatic / Every video / Off; size **Choose automatically** (quarter for 4K, or on an
  8 GB Mac; the new default), Half or Quarter; **make proxies in the background** straight away, after 5, 15 or
  30 s without a click, or only when asked (never while Reel is playing); the proxy format; and this project's
  cache (media, proxies, rendered plug-in sound) with **Delete proxies…**. PROXY ▾ › Make proxies now starts at once.
- **Layout checks at 1280×720, 1440×900, 1920×1080 and a narrow window:** a clip's level and speed badges no longer
  sit under the ⧓ at a cut or the ⚙ of a selected clip, and the Transitions panel fits a 13" screen (its fades
  were off the bottom; it scrolls now).

## 1.5.10 — Tidier pop-ups and clearer voice progress

- **Pop-up windows stay clear of the Mac's window buttons** (red, yellow, green): the Mixer, Voices, Auto Edit and
  the rest no longer slide under them at the top-left corner.
- **Kitten voices show what they're doing**: "Loading the voice model…" then "Speaking…", with a seconds count,
  so a long first line no longer looks frozen; **Cancel** stops it.

## 1.5.9 — Kitten voices: natural speech, emotion and your own cloned voice

- **Kitten voices**: the violet **🗣 VOICES** and **🎙 CLONE MY VOICE** keys in the panel on the right (also TEXT ▾ › 🗣 Speech from text, and Insert › Kitten Voices… / Clone My Voice from the Selected Clip…): KittenTTS 2
  (KittenML, Apache 2.0) on this Mac's graphics chip. 115 voices (characters such as Victor, Maeve or Marcus, and
  voices for 20 languages), an **Emotion** (joyful, sad, stern, excited…), **Delivery** (Steady or Expressive),
  beats put in at the cursor (<laugh>, <sigh>, <pause>, <um>…) and (((stress))) on a selected word. The Mac's own
  voices stay as the other engine, one click away.
- **Clone a voice from a clip**: select a clip of one person talking, put the playhead where they start, and press
  ＋ Clone a voice. Reel takes 15 seconds from there, hears what's said with the Mac's speech recognition, and saves
  it under a name (in Reel's own folder; Remove moves it to the Trash). Use it to fix a line in your own voice.
- **● Record my voice**: clone your own voice right in Speech from text, no clip needed. Read the passage shown
  (about 15 seconds) into the recording microphone, press STOP, listen back and save it. The words you read are
  the voice's text, so nothing needs to be recognised; silence at the ends is trimmed.
- **GET KITTEN VOICES** sets it up once (about 3 GB): a Python environment of Reel's own made from a Python 3.10+
  already on the Mac (Protoart Studio's, Homebrew's or python.org's), KittenTTS pinned to one reviewed commit, and
  the model in the shared Hugging Face cache. Then it runs offline; the model is unloaded soon after use on 8–16 GB
  Macs, and before recording or export.

- **The deck's reels show the tape running**: while the edit plays, the brown tape pack shrinks on the left reel and
  grows on the right one (by area, like real tape), with silver showing through the windows of the emptier reel.

## 1.5.8 — Pick several projects by dragging

- **Drag a box across the projects on the home screen** to pick every one it touches (start on a project or the
  empty space beside them; hold ⇧ or ⌘ to add to what's picked). Press **⌫** to move them all to the Trash (Reel
  asks first), **⌘A** picks every project, and **Esc** or a click on empty space clears the picks.

## 1.5.7 — Cinematic transitions, device frames, visualizers, and a plug-in crash fixed

- **Fix: “The plug-in host stopped (a plug-in may have crashed)”.** A plug-in that only takes stereo (like the stereo
  half of a Waves shell) crashed Reel’s plug-in helper when given a mono microphone recording, again for every clip
  of a track (25 crashes for one Render Into Track). The helper now checks each plug-in’s format first, feeds stereo-only
  plug-ins the recording as stereo, and names a plug-in that can’t take the sound instead of crashing; Reel stops
  after a failure instead of retrying every clip. Error messages no longer start with “Error invoking remote method”.
- **Copy and paste effects.** Right-click a clip › Copy effects (zooms and pans, picture filters, sound effects, pointer
  effects), then Paste effects onto other clips. Right-click an action › Copy this action › Paste action at playhead.
- **Auto Edit keeps sped-up clips whole** when it cuts dead air (on by default), so time-lapses stay in the edit.
- **Auto Edit motion to suit the video.** A new Motion setting: Punchy (quick push-ins and push-outs: TikTok, Reels,
  Shorts), Ken Burns (slow, steady drifts: tutorials, YouTube; now their default) or Follow the action.
- **Green screen, background removal and picture in picture, easy to find:** EFFECTS ▾ and the clip’s right-click menu.
  Picture in picture puts the clip in a corner (rounded, with a shadow); again moves it round the corners.
- **Cinematic transitions:** Cinematic fade, Dip to film, Dreamy glow, Letterbox close, Lens defocus, Exposure burn,
  Lens flare sweep, Punch zoom, Chromatic split. New Auto Edit packs: Filmic and Social (fast).
- **Cinematic filters:** Film grain, Letterbox bars (2.39 / 2 / 1.85 / 2.76 : 1), Halation glow, Chromatic aberration
  (real colour fringing, on the graphics chip).
- **Device frames:** a picture inside a browser window (with an address), a Mac window, a phone or a laptop.
- **Motion backgrounds** (Gradient flow, Bokeh lights, Tech grid, Soft waves) on their own track under everything, and
  **audio visualizers** (bars, wave, ring) that follow the sound.
- **Pointer spotlight and magnifier** in Pointer effects.
- **🎥 Stabilize** (EFFECTS ▾, or right-click a video): follows the camera shake once on small frames, keeps intended
  moves, takes out the jitter and zooms in just enough to hide the edges. Smoothness, Strength and Zoom can be changed
  any time; nothing is re-encoded and the preview and export match.
- **When the projects drive isn’t connected**, making a project asks right there: Choose another folder… or Use
  Movies › ProtoArt Reel, then makes it (no trip to Settings). The home screen says where projects are saved, with Change….
- **✍ Title, description & chapters, written by Qwen on this Mac** (TEXT ▾, and in Export): 5 title ideas, a description
  and chapter names from what’s said. Three sizes, 1.5B, 3B and 7B, downloaded from Reel; a size this Mac doesn’t
  have the memory for is greyed out with the reason. Auto Edit names its chapters with it too.

## 1.5.6 — Bounce in place, retake while recording, HandBrake-style presets

- **Bounce to a new track (render effects in place).** Select sound clips › AUDIO ▾ › ⤓ Bounce to new track (or
  right-click a clip, or a track’s name › Bounce track to a new track). Reel renders everything that shapes the sound
  before the fader: each clip’s volume, fades, crossfades, pan, speed and own effects, then the track’s effects and
  plug-ins. The result is a new WAV on a new “· rendered” track right under the original, cut into clips at exactly
  the same times. You hear and mix the processed sound straight away; the plug-ins don’t run for it any more. The
  originals stay, muted and greyed out (RENDERED ↓). The new track keeps the fader, pan and automation, so the mix
  sounds the same. Right-click › ↩ Back to the original sound (or ⌘Z) undoes it at any time.
- **RETAKE on the recording panel.** Press ↺ RETAKE twice (it asks SURE? so one slip can’t lose a take): that take’s
  files are deleted and a fresh take starts after a 3-second count, with the same screen, camera and mic, without
  going back to the editor. Also in the menu-bar icon’s menu.
- **Export presets like HandBrake.** The Preset menu has HandBrake’s groups: General (Very Fast / Fast / HQ /
  Super HQ at 4K, 1080p, 720p, 576p, 480p), Web (Creator, YouTube HQ, Social 25 MB, Discord, Email 25 MiB), Devices
  (Apple, Android, Chromecast, Amazon Fire, PlayStation, Roku, Xbox), Hardware (VideoToolbox) and Production,
  beside Reel’s own and yours. New: a Quality level, a **File size limit** (Reel works out the bitrate to fit,
  and warns when that’s too little), frame rates that never go above your project’s, the bitrate in the summary,
  and **Import HandBrake…** for your own HandBrake preset files (AV1, MKV or surround are made as the nearest MP4).
- **Fix: in a narrow window the time display slid over the transport keys** and the zoom bar hid under the tools.
  The deck now gives way step by step, and the tool strip grows when it wraps.
- **Fix: after a recording, Reel’s menu bar stopped answering** (the menu bar showed another app’s menus) until you
  switched apps. Reel now stays a normal app throughout, and clicking its window always brings its menus back.

## 1.5.5 — Menus answer every time, WAV export, clear plug-in renders, de-click

- **Colour schemes from ProtoArt Dandelion.** Settings › Appearance › Colour scheme: **Amber** (Reel’s original),
  **Powder** (blue powder coat on Light, burnt orange on Dark, white printing), **Cream**, **Slate** and **Ember**,
  each with the Light or Dark faceplate. The faceplate metal, lettering and every lit key and lamp take the scheme.
- **Help covers everything, and you can search it by describing a problem.** A **Search help…** box sits in the
  top bar next to HELP: type “export stuck”, “menu does nothing”, “mouth clicks” or “save a preset” and Help
  opens on the answer. Help has **HOW TO** and **TROUBLESHOOTING** tabs (39 topics, every feature through 1.5.5),
  understands everyday words (stuck / frozen / hangs, plug-in / VST / AudioSuite…), and Help › Search Help… and
  Help › Troubleshooting… open it too.
- **The menu bar answers every time.** After a recording, the floating recording panel switched Reel into a
  background app and back (to float on every Space), which left the menu bar, starting with the ProtoArt Reel
  menu, dead until you clicked another app and back. It no longer does. Reel also used to rebuild the whole menu
  bar after each edit (to reword Undo / Redo), and a rebuild that landed as you clicked a menu made the click do nothing. It no longer does that: the Edit
  menu says plain Undo / Redo, and the toast after each undo says exactly what was undone.
- **Sound-only export no longer looks frozen.** It now shows “Sound 1:23 of 10:11 · 40× real time · about 15 s
  left” instead of sitting on “Starting…”, and Cancel works during it. If the AAC encoder ever stops responding,
  the export stops with a message instead of hanging. If a plug-in render is already running, the dialog says it’s
  waiting for it.
- **New: Sound only · WAV** (uncompressed 24-bit, 48 kHz stereo) in Export, for mastering or editing elsewhere.
- **You can see a plug-in render happen, and see that it worked.** RENDER EFFECTS shows a meter with the percentage,
  and the clip on the timeline shows RENDERING 42% with a bar. Afterwards the clip carries a green FX ✓ badge, its
  waveform is redrawn from the new processed file (like AudioSuite in Pro Tools), and A/B switches between the
  original and the processed sound. An amber FX ! means the effects aren’t rendered yet.
- **Renders use what’s in the open plug-in window.** A plug-in’s settings were only saved when its window closed,
  so rendering with CEDAR (or any plug-in) still open ran it on its default settings. That can sound like nothing
  happened. Reel now reads the open window’s settings first, for clips, tracks and the master.
- **Your plug-ins on the master bus, right in Export.** The Master row in the export dialog has + PLUG-IN, which
  puts one of your Audio Unit plug-ins (CEDAR, Waves, iZotope, FabFilter…) on the whole mix. The same list is in
  MASTER…, in the Mixer (★ MASTER PLUG-INS) and in Window › Master Bus & Plug-ins…
- **New built-in De-click** track effect: removes mouth clicks, lip smacks, pops and crackle (presets: Mouth clicks,
  Pops & crackle, Gentle).
- **AUTO MIX can clean the dialogue.** Tick De-click (on by default), De-ess or Noise gate. They go on the dialogue
  tracks before Auto Level, where you can adjust them, and Remove Auto Mix takes them off again.
- **Music and Sound FX can go much quieter in AUTO MIX.** The sliders now reach −30 dB (up to +12), with quick
  −30 / −20 / −12 / −6 / −3 / 0 / +3 / +6 buttons.
- **Effects presets for a whole rack.** Every track’s ƒx rack has PRESETS ▾: built-in chains (Tutorial voice:
  De-click → De-ess → Auto Level · Clean dialogue (light) · Podcast voice · Noisy room), and *Save this rack as a
  preset…*, which keeps your own plug-ins (CEDAR, Waves…) with their settings. Your presets are on every track.
- **Auto Edit › Tutorial.** A new recipe for screen tutorials: it finds your clap signals and cuts them out (each
  leaves a take marker for ✂ TAKES), puts the Tutorial voice chain on the speech, evens the volume, cuts ums and
  long pauses, adds gentle zooms and chapters. Every recipe now has **Claps** (Leave / Mark / Cut them out) and
  **Voice** (any effects preset, your own saved ones included).
- **End-screen picture boxes.** The end screen’s boxes take your own pictures: drop an image on a box in the
  inspector, or press CHOOSE…. The picture fills the box, with your caption over it.
- **New recordings are at the top of Media**, with a NEW tag for 10 minutes.

## 1.5.4 — Smooth cuts, a big REC key, and fixes you asked for

- **Every cut is smooth.** Where two clips meet after a cut (a delete, ripple, Close Gaps or Auto Edit joined them),
  Reel adds a short crossfade, so the sound doesn't click and the picture doesn't jar; next to a gap the sound fades
  out and in. A plain split of continuous footage needs nothing. Settings › Timeline › Smooth every cut: Off, Short
  (0.1 s), Medium, Long. A cut set to NONE in Transitions stays a hard cut.
- **REC is a big master key** like EXPORT: cream key, red jewel lamp, in its bezel at the top of the tool panel. It
  latches down with the lamp blinking while you record.
- **A long pause no longer loses a recording.** If macOS stops the screen capture during a pause (the Mac locked),
  everything recorded is kept and saved when you resume or stop. A recording that has started is never thrown away:
  if anything goes wrong, Reel saves what it has, or keeps the files. Clicking the menu-bar icon opens its menu
  (Resume, Stop…) instead of stopping straight away.
- **Settings… answers again.** Rebuilding the menus (for the Undo / Redo wording) while one was open swallowed the
  click; menus are now only rebuilt when none is open.
- **Transitions: THIS CUT or EVERY CUT.** A clear APPLY TO switch at the top of the panel says where a click goes.
  NONE (Cut) on EVERY CUT now takes every transition off (it used to put Dissolve back on).
- **Call-outs always show, live, and open with a double-click.** Titles, call-outs, elements, shapes and drawings are
  drawn above the video even on a track below it (they used to vanish under a full-frame video). Their words
  update as you type. Double-click any clip to edit it: its settings open with the cursor in its text.
- **Markers are easy to remove.** Each marker has a flag on the timeline: click to jump, right-click to rename or
  delete (or delete them all), ⌥-click deletes. The × beside each marker on the right is always visible now.
- **Faster speeds:** up to 100× (64×, 32× and 16× buttons). The preview plays up to 16× and keeps up beyond that;
  the export uses the exact speed.
- **Parts snap together.** Part edges snap to other parts, clips, markers and the playhead, and two parts can meet
  exactly end to end (they used to stop short or merge). Moving a whole part snaps too.
- **A tidier tool bar.** One row: SELECT ▾ · BLADE · SPLICE · DELETE · GAPS ▾ (ripple, close gaps, auto) · + INSERT ▾ ·
  EFFECTS ▾ (now with CALL-OUTS) · AUDIO ▾ · TEXT ▾ · PARTS ▾ · SNAP · ⚙ ▾. AUTO EDIT is in the tool panel.

## 1.5.3 — AUTO MIX, colour-coded tracks, and exports that finish

- **⚖ AUTO MIX: dialogue, music and sound effects levelled for you.** Every sound track has a colour-coded tag:
  **blue DIALOGUE**, **orange MUSIC**, **green SOUND FX** (click it to go round them; any number of tracks can share
  a colour, e.g. two orange music tracks). The track header, its mixer strip and its clips take the colour. AUTO MIX
  (mixer, track right-click, AUDIO tab, or ⌥⌘M) reads the colours, measures every clip's loudness (the broadcast
  LUFS meter the export uses), and sets each one to its colour's level: voices clear, music under them by a set
  amount, sound effects heard without jumping out. Pick a style (Podcast, YouTube, Cinematic), nudge music or
  effects louder or quieter, and preview with A/B before you keep it.
- **Music dips while someone talks, smoothly.** Music tracks fade down just before dialogue and back up after it,
  instead of jumping. It's set on the track, so music you add later dips too.
- **Tidy tracks (save space).** AUTO MIX can put tracks of the same colour together: clips from plain tracks move
  onto one track at the same times, and the empty tracks go. Tracks with their own effects or settings stay as
  they are. Generic names ("Track 3") become "Dialogue", "Music", "Sound FX".
- **A reminder to label.** When a project has several sound tracks without a colour, Reel asks once and makes
  the unlabelled tags pulse.
- **AUTO MIX is clear about what it did.** Press **▶ HEAR AUTO MIX**: the mixer closes, the result plays straight
  away, the clips it changed flash on the timeline, and coloured chips say what moved ("DIALOGUE ▲ +10 dB · 2
  clips", "MUSIC ▼ −15 dB"). Nothing is kept until you press KEEP IT.
- **Remove Auto Mix, any time.** AUTO MIX remembers your own levels and tracks. While a mix is on, the key reads
  ⚖ AUTO MIX ✓; open it (or right-click a track, or Edit menu) and REMOVE AUTO MIX puts every clip back at its own
  level and on its own track, even after other edits. Your colour labels stay.
- **A tidier top bar.** While you edit, the studio keys (REC, TAKES, ADD MEDIA, AUTO EDIT, AUTO MIX, MIXER,
  SPECTRAL, AI IMAGE, THUMBNAIL, EXPORT) sit in a panel at the top of the right-hand column; the top bar keeps
  just the project, SAVE, CLOSE, EXPLAIN and HELP. On the Projects screen they're back in the top bar.
- **CLOSE GAPS (⌥⌫), and AUTO to never leave empty space.** Next to RIPPLE: CLOSE GAPS removes every empty
  stretch of the edit (where nothing plays on any track, including before the first clip) and slides everything
  after it up, so all the tracks stay in sync; markers, captions and parts move with it. Turn on AUTO and Delete
  closes the gap it leaves, like RIPPLE. Locked tracks are never moved.
- **Two select tools: hold SELECT.** A small panel opens with **→ SELECT** (one item at a time, as before) and
  **⇉ SELECT FORWARD**: click anywhere on the timeline and everything to the right of it is selected, on every
  track (video, audio, text, all of it), ready to drag. The key shows ⇉ FORWARD while it's on; A goes back to
  the normal select tool, ⇧A picks forward. The other selections (select all, all video, all audio…) are under
  MORE SELECTIONS, and right-click still opens them directly.
- **EXPORT is the master key.** At the bottom of the tool panel: a chunky backlit key in a screwed bezel with a
  green jewel lamp and a MASTER OUT plate. It sinks into the bezel when you press it, like a tape machine's
  transport key, so it never gets lost among the other keys.
- **Transport keys in the centre.** Play, stop, rewind and frame keys sit in the middle of the deck, over the tape
  head; the tape-speed switch and picture size are on the left, the time and the tape counter on the right.
- **Undo and Redo say what they do.** "↶ Undo: Move 2 clips" appears when you press ⌘Z, and the Edit menu reads
  "Undo Move 2 Clips" / "Redo Auto Mix".
- **Mixer: channel names at the top**, above the inserts, with the colour tag under them, so you don't have to
  scroll down to see which strip is which.

- **Exports with a plug-in on a track no longer crawl or fill the disk.** Every clip used to render the plug-in over
  its whole source recording, so a recording cut into 90 pieces was processed 90 times (about 400 MB and a few
  minutes each with a heavy plug-in like dxRevive). Now each recording is rendered once per plug-in setting and
  every clip cut from it shares that render. Change the plug-in's settings and it renders once again.
- **Long exports no longer stop with "Video decoding failed: Decoding error".** Each clip kept its own video
  decoder open until the export ended; macOS has only a few, so an edit with dozens of clips cut from one recording
  ran out part-way. Clips now let go of their decoder as soon as they're off screen, and clips from the same
  recording share one reader instead of each reading the whole file's index.
- **Space back from older projects.** Opening a project that already has those duplicate renders points every clip
  at one copy and moves the spare copies to the Trash (empty the Trash to get the space back).

## 1.5.2 — Takes, a tidier tool bar, and edits that stay together

- **✂ TAKES, in the top bar next to REC.** Messed up a line while recording? Clap three times (or press ⌥⇧⌘M, or
  MARK on the recording panel) and say it again. When the recording ends, Reel splits it into takes at each clap,
  like the takes of a voice-over, and opens TAKES: the take before each clap is marked DROP, the last is kept.
  Play any take, switch KEEP / DROP, then **REMOVE DROPPED TAKES** cuts them, claps and all, and closes the gaps
  (⌘Z brings them back). The key shows how many takes the project has; also Edit › Takes… (⌥⌘T).
- **Auto Edit one clip.** Right-click a clip › **⚡ Auto Edit this clip…** (or Clip › Auto Edit This Clip…) tidies
  just that clip and the clips grouped with it: cut ums and pauses, zooms, transitions, captions. The rest of the
  project isn't touched; what comes after moves to fit. Compare or DISCARD it like any Auto Edit.
- **Grouped clips trim together.** Drag the edge of a recording's screen clip and its sound (and camera) trim
  with it, like ScreenFlow and Resolve. Trim to playhead does the same. ⌥ still trims one clip.
- **Snapping that connects.** Drag a clip into its neighbour and it lands flush against it in one move, instead
  of stopping short. Snapping also reaches a little further (14 pixels).
- **A tidier tool bar, on one row.** Editing tools stay in view; the rest are in EFFECTS ▾ (transitions, presets,
  Smart Zoom, time-lapse, vertical), AUDIO ▾ (voice over, ADR, takes), TEXT ▾ (captions, edit by text),
  PARTS ▾ (keep a part, In / Out) and ⚙ ▾ (proxies, scrub audio). A group lights up while one of its tools is on.
- **ADR guide track,** like VocALign: with ADR on in VOICE OVER, choose which track holds the original dialogue
  (or leave it on automatic).
- **Recording dialogue over sound:** the first time, VOICE OVER asks whether to mute the edit while you record (so
  it doesn't leak into the mic), and remembers your answer.
- **Reel remembers more:** the window's size and place, the screen or window you recorded last, and the size and
  frame rate you chose for a new project.
- **Your own keyboard shortcuts:** Settings › **Keyboard Shortcuts** lists every command (the editing keys like
  S, M, I / O and everything in the menus). Click one, press the keys you want; Reel warns if they're taken and
  offers to move them. ⌘ / ⌃ / ⌥ shortcuts show in the menus too. Search, clear, or reset any of them.
- **Fix: the menu bar (File, Edit…) wouldn't open, and Reel felt sluggish.** Each time the preview played, seeked
  or drew a waveform, Reel's main process read the rest of the media file into memory as fast as it could
  (gigabytes on a long recording), too busy to answer the menu bar. It now reads only as fast as the editor uses
  the data, a few MB ahead, which also saves a lot of memory on 8 GB Macs.
- **Lock a track.** The 🔒 button on a track's header (or right-click the track › Lock track) locks it: nothing on
  it can be moved, trimmed, cut or deleted, ripple edits and Auto Edit elsewhere leave it exactly as it is, and
  nothing new lands on it. It's hatched while locked. Unlocking gives the clips back as they were.
- **Plug-ins on the master bus, easy to find.** The MIXER's master section has ★ MASTER PLUG-INS… (also Clip ›
  Master Bus & Plug-ins…): your own plug-ins on the whole mix, plus loudness and a limiter, applied to the export.
  Before, they were only reachable from the Export window.
- **Drops land where you can see them.** A file dropped on the preview (or anywhere but the Media panel) goes on
  the timeline at the playhead; one dropped on a track goes on that track. The timeline then scrolls to it, selects
  it and makes it glow for a moment (a sound file can land on a track below the fold, which looked like nothing
  happened). Files dropped on the Media panel go into the Media list, and Reel says so.
- **Fix: dropping files said “Nothing in that could be imported”.** Reel now reads where each dropped file is at
  the very moment of the drop, one file at a time (falling back to the drop's file links), follows aliases and
  symlinks to the real file, and says exactly why a file was skipped.
- **Dropping WAV files and videos works, and shows progress.** WAVs from recorders and DAWs (big bext / iXML
  headers before the sound) failed with "Unreadable WAV"; they come in now, and unusual WAVs (8-bit, 64-bit,
  compressed) are converted. Files from another drive are copied with a progress bar instead of looking stuck,
  and the media list no longer redraws under a drag in progress.
- **Fix: waveforms on long recordings were squeezed.** A clip wider than 8000 pixels on the timeline (an hour of
  microphone at a normal zoom) drew its whole waveform into the first part of the clip, so speech showed where
  there was silence and jumped when you dragged a cut. Waveforms are now drawn in tiles, only where you can
  see them, and line up at every zoom.
- **Help you can search.** HELP (How ProtoArt Reel works) has a search box: type a question or a word ("pause",
  "claps", "shortcut", "plug-in") and the topics that answer it stay, with the words lit. It covers everything
  up to this build, and the key caps are readable in light mode.
- **Plug-ins: RENDER INTO TRACK, and closing keeps your settings.** The LISTEN LIVE bar (and right-click on a
  plug-in in the track's rack) can render the plug-in into the track's sound for good, taking it off the strip;
  or leave it, and it's applied at export. Fix: CLOSE PLUG-IN threw the plug-in's settings away and left the bar
  stuck on screen.
- **Auto Edit zooms that show.** Zooms are now planned on the whole take before the ums are cut (the pieces left
  afterwards were mostly too short to zoom in on), clips with nothing to follow get gentle push-ins, and the
  summary says how many zooms were added.
- **Fix: waveforms didn't match what you heard.** The playhead followed the sound as it left Reel, not as it
  reached your ears, so with a large playback buffer or an audio interface you heard words over what looked like
  silence. Sound clips now play early by your sound card's delay, so the sound, the playhead and the waveform
  line up. Settings › Playback & Recording › **Sound sync** can set it by hand.
- **Fix: Settings didn't open** (ProtoArt Reel › Settings…) while the Mac was slow to list its audio devices. It
  opens at once now and fills the device lists in when they arrive.

## 1.5.1 — Pause, clap markers, and a SAVE key

- **Pause a recording, like ScreenFlow.** The floating panel has **PAUSE / RESUME** (also ⌥⇧⌘2, the menu-bar icon,
  and File › Pause / Resume Recording). Screen, camera, microphone, computer sound and each app's sound all pause
  in the same instant, so the files simply leave the pause out and stay in sync. The panel's lamp turns amber and
  its counter shows only the time recorded. The pointer, clicks and keystrokes skip the pause too, and a
  "Stop after" timer counts recorded time.
- **Clap three times to mark a cut.** After each recording Reel listens to the microphone for three quick, even
  claps and puts a **✂ Clap** marker there, or cuts the claps out and leaves a marker at the cut (Settings ›
  Playback & Recording › *Clap three times to mark a cut*). Edit › **Find Clap Markers…** does the same for any
  clip, including imported ones. Single claps, applause, typing and speech are ignored.
- **Mark while recording:** press **⌥⇧⌘M** or **MARK** on the floating panel, and a marker lands at that moment.
- **A recording's clips are grouped.** Screen, camera, microphone and computer sound from one recording now come
  in grouped, so clicking or dragging one moves them all. UNGROUP splits them. Splitting a group gives each side
  its own group, and duplicating a group makes a new one.
- **A SAVE key** in the top bar, next to CLOSE (also File › Save, ⌘S). The SAVED lamp lights when it's done.
- **Fix: screen recordings showed tiny in the corner of the preview** while their proxy was in use. The proxy is
  now drawn at the full size of the original.

## 1.5.0 — Hear your plug-ins live, like a DAW

- **Plug-ins play live while you adjust them.** Put one of your own plug-ins (Waves, iZotope, FabFilter…) on a track in the mixer, click it to open its window, and press **Space**: that track plays through the plug-in in real time, so every knob you turn is heard right away. It follows the playhead from clip to clip and plays through your chosen output (your audio interface too).
- **A banner says exactly what's happening.** With a plug-in window open, an amber **LISTEN LIVE** banner tells you to press Space (or click ▶ PLAY). While it plays, a red pulsing **LIVE** lamp shows you're hearing it through the plug-in, and the plug-in on the mixer strip lights red. **CLOSE PLUG-IN** goes back to normal playback; your settings are kept.
- **Drag a clip over another to crossfade.** On the same track, drag a clip (sound or video) so it overlaps the one next to it: a tag shows "⤫ CROSSFADE 1.00 s — let go to blend", and when you let go the two blend smoothly, sound and picture. The more you overlap, the longer the crossfade. Drag them apart to remove it, or ⌘Z.
- **Delete all captions, easy to find.** A red 🗑 DELETE ALL CAPTIONS button at the top of the Captions section (with how many there are), in the CAPTIONS window, a red 🗑 DELETE ALL button on the caption lane (left of + and CC), right-click on the caption lane, and File › Delete All Captions. It asks first, and ⌘Z brings them back. Right-click a single caption to delete just that one.
- **Recordings come in lined up.** The screen, microphone, camera and computer-sound recorders start a split second apart, which left the clips' edges ragged. Reel now trims those slivers, so a new recording's clips start and end together, still in perfect sync.
- The export still applies every track plug-in at the end. One track at a time is live; the others play as usual.

## 1.4.9 — Auto level, and sound effects you control
- **Auto Level (even volume):** a new effect that rides the volume like an engineer on a fader. It turns quiet
  passages up and loud ones down toward an even level, and leaves silence and room noise alone, even right after
  a loud part. You can set the target level, how far it may turn up or down, and how fast it reacts. It comes
  with presets (Voice — even, Podcast — tight, Music — gentle), and playback and the export use the same code.
  - **Auto Edit:** a new **Volume: Leave it / Even it out** setting, on by default. It puts an Auto Level on each
    track with speech or music, never on sound effects.
  - **Anywhere:** "+ effect" on any track or the mix bus, or right-click a track › **Auto-level this track**.
- **Sound effects in Auto Edit: Off, Quiet, Normal or Loud.** They go on their own Sound FX track at that
  level, and the preview bar has a **🔊 SOUND FX ON / OFF** switch to hear the edit without them.
- **Your installed plug-ins are easy to reach:** the clip's **AUDIO** tab has a **+ PLUG-IN** button next to
  SPECTRAL, and every **+ effect** menu (mixer strips, track racks) has "Your plug-ins (Waves, iZotope,
  FabFilter…)". Reel runs the Audio Unit versions, which most makers install alongside their VST3. The plug-in
  list now names any plug-ins installed only as VST3, so it's clear why one is missing.
- **Your plug-ins as real inserts on mixer strips and track racks:** "+ effect › ★ Your plug-ins" puts the
  plug-in on the channel strip (shown as ★ name). Click it to open its window. It applies to every clip on that
  track, after the clip's own effects.
  - **Hear it live, like a DAW:** with the plug-in's window open (click it on the strip), press Space. The track
    plays through the plug-in in real time, so every knob you turn is heard as you turn it. It follows the
    playhead from clip to clip and through seeks, and plays through your chosen output at the clip's and
    track's level. Close the window to go back to normal playback.
  - **The export renders it at the very end,** so nothing renders while you edit. Right-click › **Render this
    track now** to hear it without its window open.
  - To render while you edit instead: Settings › Processing › **Your plug-ins on tracks**.
  - Bypassing, removing or undoing it, or moving a clip to another track, is followed automatically.
- **Fix: picking a plug-in did nothing.** The list counted its own closing as "cancel" before your choice went
  through. This affected the clip FX tab, the AUDIO tab and the mixer.
- **Auto Level anywhere:** right-click an audio clip › **Auto Level**, or the **Auto Level** switch in the clip's
  AUDIO tab. It works on the clip's track (shown by name), the same as right-click a track › Auto Level.
- **Light mode: New Recording (and other dark panels) were dark text on dark:** the option panels now take the
  light faceplate finish, with readable labels and descriptions.
- **Fix:** with sound effects on, the Clean and Smooth transition styles added no sounds at all, because their
  transitions (blur, dip to black…) had none. They now have soft swishes, as do the wipes, zooms and other
  transitions that were silent.

## 1.4.8 — Pick parts by dragging, transitions like CapCut, a fuller mixer
- **Pick parts without keyboard shortcuts:** the guide is now 1 Add a video → 2 Pick parts (optional) → 3 ⚡ Auto
  Edit → 4 Export.
  - Press the green **✚ KEEP A PART** button (or step 2) and drag across the timeline over each part you want.
    Kept parts are outlined in green, and everything else is greyed out. Each part has a × to drop it.
  - **Adjust a part after drawing it:** drag its green left or right edge to change where it starts or ends,
    or drag its PART tag (or inside it, while KEEP A PART is on) to move it. Parts never run into each other,
    and ⌘Z undoes each change. Dragging inside a kept part no longer adds another one on top of it.
  - There's no limit on how many parts you keep. Before, setting a new Out without a new In started the part at
    0:00, so it merged into the first part, and it looked like you couldn't add more. Fixed.
- **Transitions and fades are easy to find, like CapCut:**
  - Every cut between two clips has a **⧓** button; it's lit when there's a transition. Click it, or
    **⧓ TRANSITIONS** on the tool bar, to pick from 21 animated previews (hover to play one).
  - The panel has a length slider, **APPLY TO EVERY CUT**, and **Fades**: fade in, fade out, no fades, and
    **FADE THE WHOLE VIDEO** (in from black and out to black, sound too).
- **Clip speed like ScreenFlow:** the speed badge on a clip opens a panel with Duration, a Speed slider, a %
  field, preset speeds (the current one lights), and switches that stay lit for Keep pitch, Play in reverse and
  Locked.
- **Mixer:**
  - Every track's strip has its own meter, showing what that track is playing. Before, only tracks with an
    effect showed a level.
  - Every fader has a **CLIP** light (it lights at 0 dB and stays lit until you click it) and a peak-hold
    readout.
  - Double-clicking anywhere on a fader resets it to 0 dB.
  - The **mix bus has inserts**: add a leveler, compressor or EQ to the whole mix. A **limiter is on by
    default**, so the mix never clips; you can change or remove it. It applies to playback and the export.
- **Voice-over takes: KEEP or DISCARD.** After each take you can play it back and keep it or throw it away.
  Discarding removes it from the timeline and the project.
- **Vertical video without black bars:** Make Vertical and Auto Edit can put the whole picture over a **zoomed
  copy of itself** (it seems to carry on above and below), over a **blurred copy**, or with **black bars**, as
  well as cropping to follow the action. The fill goes on its own Background track.
- **EXPLAIN** is in the top bar in SIMPLE mode too.
- **The inspector no longer runs off the right edge:** side panels fit the window even after being dragged wide.
  The clip speed section had been forced too wide; that's fixed.

## 1.4.7 — Auto Edit several parts of a long video
- **Sections:** pick several parts of a long video, for example the first 10 minutes and a stretch at 30:00, and
  Auto Edit blends them into one edit.
  - **How to mark them:** set In and Out around a part, then press **X** (or **[ IN · OUT ] · + SECTION** on the
    tool bar, or Edit › Add In–Out as an Auto Edit Section). Repeat for each part.
  - **On the ruler:** sections show as numbered amber bands (§1, §2…). Right-click the ruler to remove one or
    clear them all. They move with your edits like markers do.
  - **In the Auto Edit window:** the parts are listed, each with a × to leave it out.
  - **Short recipes** (TikTok, Shorts, Podcast) take the best moment from each part, sized to the part, and
    join them in order. There's always a transition where two parts meet, on top of the amount you chose.
  - **Several Shorts** makes one short per part.
  - **YouTube video** joins the parts whole and tidies them.
  - The current In–Out is included too, even if you haven't pressed X for it yet.

## 1.4.6 — Auto Edit: how strong, and which part
- **Set how strong each effect is** in Auto Edit. Each recipe sets a starting point; change any of them, and
  your choices are remembered per recipe (Back to this recipe's settings resets them):
  - **Zooms:** Off, Subtle, Medium, Heavy.
  - **Transitions:** Off, A few, Some, Lots, in any style (Clean, Smooth, Punchy, Glitchy, Cinematic), with or
    without sound effects.
  - **Captions:** Off, Subtitle file, In the video, or Big & bold.
  - **Clean up:** Off, Gentle or Tight.
  - "Reel will" lists exactly what it's going to do.
- **Auto edit just part of a video:** set In (I) and Out (O) on the timeline, then AUTO EDIT. "Only the part
  between In and Out" is ticked for you, and best moments are picked from inside it. DISCARD brings the rest
  back.
- **Transitions on a single long take:** with nothing to cut between, Auto Edit now cuts between sentences
  (nothing is removed) at about the spacing you chose, so the transitions land where the talk changes. Before,
  "Lots" of transitions could give none.

## 1.4.5 — Preview Auto Edit before you keep it
- **Auto Edit now ends in a preview, not a window over the picture.** The result starts playing in the viewer,
  with a bar over it:
  - **▶ PLAY** watches it from the start.
  - **AUTO EDIT | ORIGINAL** flips between the result and your untouched video.
  - **DISCARD** goes back to the original.
  - **TRY ANOTHER…** goes back to the original and opens Auto Edit again, to try another recipe or length.
  - **EXPORT…** and **KEEP IT** finish up.
  - **▴** shrinks the bar to a small tab.
- **Change the result before you decide:** while the preview is open the whole editor works (trim or move clips,
  drag zooms, fix a caption). Your changes are kept when you flip to the original and back, and when you keep it.

## 1.4.4 — Simple enough for anyone
- **SIMPLE and FULL:** a switch in the top bar, and in Settings › General. New installs start in SIMPLE.
  - SIMPLE shows the essentials, with bigger keys: SELECT, BLADE, SPLICE, DELETE, INSERT, PRESETS, VOICE OVER,
    CAPTIONS, VERTICAL and zoom.
  - Everything else is one click away under MORE TOOLS (on the tool bar) and MORE (in the top bar).
  - FULL is the studio as before.
- **Colour by job:** REC is red, ADD MEDIA blue, ⚡ AUTO EDIT amber (now in the top bar too), and EXPORT green.
- **A 1 → 2 → 3 guide across the editor (SIMPLE):** Add a video → Edit (AUTO EDIT or by hand) → Export. The next
  step glows, a line says exactly what to do, and each step is a button.
- **An empty timeline says what to do:** "Drag a video here to start", with ADD A VIDEO and RECORD MY SCREEN
  buttons.
- **The start screen leads with two big buttons:**
  - **EDIT A VIDEO** picks a video and puts it straight on the timeline, shaped like the video, so a phone
    video stays vertical.
  - **RECORD MY SCREEN** starts a recording.
  - Open, empty project and templates sit underneath.

## 1.4.3 — AUTO EDIT
- **⚡ AUTO EDIT (⌥⌘E, in the tool bar and the Edit menu):** pick what you're making and Reel edits your video
  for it, using its own tools in order: it listens to the speech, picks the best moments, cuts ums and dead air,
  reframes, adds Smart Zoom, a transitions pack (with sound effects), captions, chapters and the right loudness.
  - **TikTok · Reels:** the best 15–60 s as a 9:16 short. It starts on a strong line, with heavy zooms, punchy
    transitions and big burned-in captions.
  - **YouTube Shorts:** the same, up to 60 s, mixed for YouTube.
  - **Several Shorts:** the 3 best moments, each marked "Short n", ready to export one at a time with In and
    Out.
  - **Podcast clip:** a 30–90 s highlight with the whole picture on a blurred background, gentle zooms and
    big captions.
  - **YouTube video:** the whole video, tidied. Ums and long pauses are cut, with medium zooms, smooth
    transitions, chapter markers, captions as an .srt and YouTube loudness.
  - Best moments come from what's said (lively delivery, hooks, questions, little dead air), always starting
    and ending on whole sentences. With no speech, Reel goes by where the picture moves most.
  - Transitions are spaced out, so the many small cuts left by removing ums don't each get one.
  - Each part can be switched off. **Undo Auto Edit** puts the project back exactly as it was, and everything
    it adds can be changed by hand.
- **Zooming the timeline keeps the playhead where it is:** −, + and the zoom slider zoom around the playhead
  (centring it if it was off screen), like MAX IN.

## 1.4.2 — Sound through your interface, clearer Make Vertical
- **Reel's sound could end up on the Mac's default output, with a slapback echo:** the per-app mixer (MIXER ›
  MAC APPS) could tap Reel itself. Once Reel had a setting there, its real output was muted and a delayed copy
  was replayed on the Mac's default output (a display's speakers), whatever output you'd picked.
  - Reel now never taps its own sound.
  - Any saved setting for Reel from older builds is removed at launch.
- **No more doubled sound from 1.4.1's output fix:** clips no longer switch their own output while their sound
  also goes through the mix.
- **The chosen output is found again by name** if macOS gives it a new ID (after replugging, for instance). If
  it isn't connected, Reel says so.
- **Make Vertical explains itself:** shape cards with a little frame of each ratio, three clear ways to fit the
  picture, a sentence saying exactly what will happen, and a picture of your current frame before and after
  (on a phone). The choices were unreadable in light mode; they aren't now, and neither are the cards in
  New Document, Smart Zoom and Time-lapse.
- **The zoom controls sit together in the middle of the tool bar:** MAX IN, −, the slider, + and FIT ALL, on
  their own row when the window is narrow.
- Canvas sizes include 1080 × 1350 (4:5 portrait).

## 1.4.1 — Removable inserts, track dragging, output routing
- **Sound now goes to the output you pick (Scarlett Solo, etc.):** playback used to start on the Mac's default
  output (a display's speakers) and then try to switch over, and if the switch failed it stayed there without a
  word. Reel now opens its sound straight on the chosen output, each clip's sound follows it, and if macOS
  refuses the output you're told why.
- **Mixer inserts can be removed:** each insert has a × button, and right-clicking it gives bypass, presets,
  duplicate, replace, move up/down and remove. The same menu is on the timeline's effect rack, and an effect's
  control window has a REMOVE key. All of it is undoable.
- **Drag tracks to reorder them, like ScreenFlow:** grab a track by its ☰ grip or its name and drop it where the
  line shows. Its clips, effects and settings go with it, and Esc cancels the drag.
- **A full menu for every track:** right-click a track header or mixer strip for rename, move up/down, new
  track above/below, duplicate track with its clips, bypass or remove all effects, remove automation, reset
  volume and pan, select its clips, and delete. A track that has clips can now be deleted too (it asks first,
  and undo brings it back).
- **Things you could add but not take off:**
  - Captions: Delete all.
  - Clips: Remove transitions (on everything selected, crossfades included), Remove all filters.
  - Media in use: Remove from project with its clips (undoable; the file stays in the project folder).
  - Projects screen: Rename and Duplicate.
- **Window sizes:** the top bar tightens first, then folds the keys that don't fit into MORE ▾ instead of
  cutting them off. The spectral editor's module rack no longer clips its keys and stacks on narrow windows.
- **Timeline zoom keys** (MAX IN, −, +, FIT ALL) are light blue so they're easy to find.

## 1.4.0 — Presets, mixer, light mode, captions, hour-long spectral editing
### Fixes
- **ScreenFlow imports were too dark and too saturated:** ScreenFlow stores full-range colour, and Reel's
  conversions labelled it as video range.
  - New imports convert it properly.
  - Videos imported before this are corrected exactly when their project opens: one bit in the file's
    colour label is fixed in place, with no re-encoding, and their proxies are made again.
- **ScreenFlow transitions no longer add layers:** a cross-fade between two clips used to go on an extra
  "(overlap)" track, because Reel couldn't overlap clips on one track.
  - Reel now has crossfades within a track, like a DAW: the clips meet at a cut and each plays a little past
    it (its handle) while picture and sound blend, equal-power so the level doesn't dip. A wedge on the clip
    edges shows each one.
  - Moving transitions (push, slide, zoom…) become the same transition at the cut, half on each side.
  - Projects imported before this are folded back onto their own tracks when they open; the "(overlap)"
    tracks disappear.
  - Splitting, moving or trimming a clip away removes its crossfade cleanly.
  - ScreenFlow zooms, pans and fades on one clip were already keyframes on that clip, never layers.
- **Mixer › MAC APPS:** only shows apps that are playing sound. Apps that are open but silent (QuickTime
  Player sitting idle, helpers) are behind the IDLE button.

### Settings like a DAW's Preferences, and a live mixer
- **Settings (⌘,) has ten pages:** General, Appearance, Audio Hardware, Playback & Recording, Timeline &
  Editing, Processing & Performance, Spectral Display, Media & Storage, Export and This Mac. Every setting
  changes something real:
  - Autosave interval, undo levels, time display and what opens at launch
  - Playback buffer, scrub sound, recording and voice-over defaults
  - Track height, snapping, default transition, picture and title lengths, and Smart Zoom on drop
  - Viewer quality, proxies, the spectral editor's memory, and hardware or software encoding
  - Spectral display defaults (FFT size, scale, colours, range, waveform)
  - Export sound quality and the loudness target for new projects
- Options a Mac can't run well are greyed out, with the reason. RESET ALL SETTINGS puts everything back.
- **The mixer follows the timeline live:**
  - A track added anywhere (on the timeline, by an import, or with + TRACK in the mixer) gets its strip
    at once, and a removed track (or an undo) takes its strip away.
  - Double-click a strip's name to rename the track.
  - The new MIX BUS fader sets the level of the whole edit, in playback and in the export. MONITOR still
    only changes what you hear.

### Hour-long spectral editing, and a light mode
- **The spectral editor now works on files hours long**, the way RX and Audition do: the sound stays on
  disk and is read in 10-second blocks as needed. Edits are kept as a list, and a block is made by applying
  the edits that reach it. A fixed-size cache and an overview of the whole file keep memory about the same
  for a 3-minute clip and a 3-hour podcast. A fix across the whole file applies at once; its picture fills
  in in the background while you keep working. The old 5-minute limit (20 minutes on 16 GB Macs) is gone.
- **Light mode:** Settings › Appearance (Dark, Light, or match macOS), or View › Light / Dark (⇧⌘L).
  - Light is a brushed-aluminium faceplate, like a light-grey large-format console, with dove-grey keys
    and paper scribble strips.
  - Knobs, faders, VU meters, lamps, LED displays and tape reels look the same in both modes.
  - The window's own title bar and menus follow the chosen mode.

### Fits the Mac it runs on
- Reel is built for an 8 GB M1. The few options that need more memory, or a newer macOS, stay visible but
  greyed out, with the reason on hover. On Macs that can run them, they're simply there:
  - Recording above 4K
  - Recording 60 fps at 4K
  - Accurate background removal
  - Pitch-kept speed changes over 10 minutes in the export
  - Per-app sound, which needs macOS 14.2
- **Settings › This Mac** shows the chip, the memory and macOS, lists which options are available, and can
  unlock the memory-hungry ones anyway.

### Presets library (★ PRESETS, ⌥⌘P)
- **One browser for every preset:** cut transitions, transitions, title animations, motion presets,
  animated elements and sound effects. Each tile plays a live preview when you point at it, and a click
  applies it to the selection, or adds it at the playhead. You can search the whole library.
- **Cut transitions** play across a cut, so the outgoing shot hands over to the incoming one: zoom through,
  spin through, whip through, blur through, light leak, film burn, flash, glitch and shake. A click puts one
  on the cut nearest the playhead; ⌥-click puts it on every cut.
- **20 animated elements**, each with editable words and colours:
  - Four lower thirds
  - A call-out label and a speech bubble
  - Shapes: burst, ring pop, hand-drawn circle and arrow, underline swipe, highlight box, check and cross marks
  - Particles: sparkles and confetti
  - A subscribe button with a click, an emoji pop, a number counter and a progress bar
- **13 sound effects** made by Reel, so they're free to use anywhere: whoosh, swish, riser, hit, boom, pop,
  click, ding, glitch, camera shutter, typing, sparkle and record scratch. Transitions can add a matching
  sound on a Sound FX track.
- **AUTO:** puts transitions on every cut in one of five styles (Clean, Smooth, Punchy, Glitchy, Cinematic),
  with matching sounds. It can first scan the clips and cut them where the shot changes.
- **Smart Zoom and Time-lapse** can do the same while they scan the video. Time-lapse only adds them where
  the speed jumps.

### Mixer, track effects and clip controls
- **SOUND is now MIXER.** TIMELINE TRACKS shows a channel strip for every track of the edit, in timeline order:
  inserts (effects), EQ, pan, mute, solo and a fader with a meter. These change the edit and the export.
  MIC INPUT is a channel of its own. MAC APPS holds each Mac app's sound.
- **Track effects:** the **fx** button on a track header opens a numbered rack under the track. Each slot has a
  power switch, the effect's controls and presets. The effects are EQ, compressor, de-esser, noise gate,
  reverb, delay, limiter and gain/polarity. The same code plays live and renders in the export.
- **SPECTRAL** has its own button next to MIXER and opens the spectral editor for the selected clip.
- **Clip badges** like a DAW's: drag the clip gain (dB) up or down, and click the speed % for choices.
  The ◢ handle at a clip's end stretches its speed; the white squares at the top corners are fades.
- **Disable a clip (V):** it stays on the timeline but isn't seen or heard.
- **Video levels** in the VIDEO tab: brightness, contrast, saturation, black and white levels, midtones,
  output levels and Auto levels.
- Speed has its own **SPEED** tab in the inspector; it used to be repeated on every tab.
- **Resizable panels:** drag the dividers between the media list, the viewer, the inspector and the timeline.
- **Zoom and hand:** a mouse wheel or trackpad pinch over the timeline zooms it, and ⇧-wheel scrolls
  sideways. Press the middle button and drag to move around the timeline or the viewer.

### Audio devices, recording and storage
- **Device names fixed:** Reel's permission check rejected its own pages, so only "Mac's input / output"
  showed. Interfaces like a Scarlett Solo now appear as inputs and as the monitor output.
- **Settings › Audio Hardware**, laid out like a DAW's preferences: default input and which input of it,
  default output with a test tone, sample rate, I/O buffer size, and the outputs macOS reports.
- **Record window:** mic input (input 1, input 2, both mixed, or stereo), sample rate and monitor output.
  A Scarlett's mic is now recorded centred, not on the left side only.
- **Settings › Storage:** choose where new projects and their recordings are saved, including an external
  drive. Projects saved in other places still show on the Projects screen.
- **Projects screen:** SELECT… shows checkboxes so several old projects can be moved to the Trash at once.

### Speech, captions and ADR
- **CAPTIONS (Auto Captions):** Reel listens to the speech and writes timed captions, in 16 languages.
  It uses macOS speech recognition, which runs on the Mac when the language allows.
- **TEXT EDIT (Edit by Text):** a transcript of the edit. Click a word to jump to it. Select words and
  press Delete to cut them from every track. REMOVE FILLERS cuts um, uh and "you know", and TIGHTEN PAUSES
  shortens long silences. You can also find a phrase and cut every place it's said.
- **ADR** has a toolbar button. Voice Over has an "ADR: align each take" option that lines each new take up
  with the original line under it.

### Formats, zoom and motion
- **VERTICAL (Make Vertical):** re-frames the edit for 9:16, 4:5 or 1:1. Choose Follow the action (the
  pointer, or where things move), Centre crop, or the full picture over a blurred copy of itself.
- **Smart Zoom intensity:** Subtle, Medium or Heavy, also available in Time-lapse.
- **31 transitions:** the new ones include flash, push, whip pan, rise, drop, spin, elastic, glitch, wipes
  in four directions, iris, clock wipe, barn doors, blinds and a diagonal wipe.
- **7 new title animations:** wave, blur in, scramble/decode, tracking in, swing, roll up and stamp.
- **Motion presets** in the MOTION tab: Ken Burns, pans, tilt, handheld, punch in and out, zoom hit,
  shake, pulse, float, swing, pop, spin, slide, drop in and rise out. Each is made of ordinary keyframes,
  so it can be fine-tuned afterwards.

### Fixes
- Playback sound no longer crackles or skips. The timeline now follows the audio clock instead of seeking
  the sound, and the audio graph only changes when something has actually changed.
- Holding Space no longer flickers playback on and off.
- **ScreenFlow import:**
  - Sped-up clips were 3–30× too long, which piled them onto extra "overlap" tracks and doubled the sound.
    They now keep the right length.
  - Pictures came out too dark: ScreenFlow stores full-range colour, which is now converted. Earlier
    imports are corrected on playback.
- Proxies made in an earlier session are reused instead of being made again as "proxy-2" copies.
- A long project name no longer runs under CLOSE.
- The tool strip wraps onto a second row instead of hiding tools off the edge.

## 1.3.0 — New Document, templates, proxy editing
- **New Document** (New Empty Project): pick a preset (1080 vertical, 1080p, 4K, 1440p, 720p, square,
  4:5, Mac screens) or type a width and height, and a frame rate (24–60).
- **Built-in templates** for YouTube, YouTube Shorts, TikTok, Instagram Reels, Instagram feed and square
  posts. Each has Titles, B-roll, Main video, Voice, Music (−9 dB) and Sound FX tracks, an animated
  title card, a placeholder for your video, an end card that fades the video out, and two markers.
  They're in New Document and in File › New from Template.
- **Proxy editing**: 4K, HEVC and ProRes videos get a half-size (or quarter-size) H.264 copy made in the
  background; the preview plays it so playback and scrubbing stay smooth. The sound is copied across
  untouched. Export, thumbnails and freeze frames always use the originals. PROXY button on the tool
  strip: Automatic / Every video / Off, Half / Quarter size, make now or stop. A missing proxy falls
  back to the original by itself.
- **Any media format**: drag in (or ADD MEDIA) almost any video, sound or picture. What the editor can't use as
  it is gets converted once, as it's added, and your original file is never touched:
  - **Pictures**: HEIC/HEIF, AVIF, TIFF, BMP, PSD/PSB, JPEG 2000, TGA, ICO/ICNS, EXR/HDR, PICT and camera RAW
    (DNG, CR2, CR3, NEF, ARW, RAF, ORF, RW2, PEF, SRW…) become JPEG (PNG when they have transparency), at full
    size, upright. SVG is used as it is.
  - **Sound**: MP3, AIFF, CAF, FLAC, Apple Lossless, AAC/ADTS, AC-3/E-AC-3, AMR, AU, W64/RF64… become 32-bit WAV;
    Ogg Vorbis, Opus and Speex through the editor's own decoder.
  - **Video**: ProRes and other MOV/MP4 the editor can't export, AVI, MPEG-1/2 (MPG, VOB, M2V), AVCHD/MTS/M2TS/TS,
    3GP, DV, MXF… become MP4 (H.264, or HEVC above 1080p) with AAC, using macOS's own converter.
  - **WebM / MKV / MKA** (OBS, browsers, screen recorders): H.264 / HEVC with AAC are repackaged into MP4 without
    re-encoding (fast, no quality loss); VP8, VP9 and AV1 with Opus, Vorbis, FLAC, MP3 or PCM are converted to
    H.264 + AAC; sound-only files become WAV.
  - A progress window shows while files convert. WMV, FLV, RealMedia, WMA and MIDI can't be read on a Mac without
    extra software, and Reel says so.
- **Microphone permission**: when macOS hasn't let Reel use the microphone (each rebuild can count as a
  new app), device lists showed only "Input 1". Reel now asks for it, and if macOS says no, SOUND,
  Settings and Voice over show *Allow the microphone* with OPEN (straight to Privacy & Security ›
  Microphone) and RETRY; the lists refill by themselves when you come back.
- **SOUND console is light again**: the LED ladders are drawn on one canvas per fader and only when a
  level crosses an LED; the knob tick rings are a static image; each strip paints on its own; the
  monitor meter updates 20 times a second instead of every frame. No more flicker, and DONE closes at once.
- **Space in SOUND** plays / pauses the edit (to watch the meters) instead of pressing the last button
  again (which re-sent every strip).
- **Pick your audio devices by name** (Scarlett Solo, AirPods, MacBook Speakers…): SOUND's master section
  now has INPUT (MIC), with a live level, and MONITOR OUT; Settings (⌘,) and Voice over list the same
  named devices. macOS only reveals device names once the microphone has been opened, so Reel opens it
  for a moment when the names are missing.
- **Every app's channel strip shows its level** while SOUND is open (listen-only taps that end when you
  close it), not only apps you've changed.
- **Template thumbnails**: New from Template shows each built-in template as a card with a picture of its
  frame, title card and platform (YouTube's progress bar, the side buttons of TikTok / Shorts / Reels);
  New Document's template buttons use the same pictures.
- **Spectral editor, round 2 (the RX / Audition way of working)**:
  - Click anywhere on the spectrogram (or the time ruler) to put the playhead there; drag to select.
    ▶ PLAY plays from the playhead (Space), ▶ SEL plays the selection (⇧Space), ⟲ LOOP repeats it (⌘L),
    |◀ goes to the start; the view follows the playhead; a readout shows the time and pitch under the pointer.
  - Fixes are modules: picking one only shows its settings. PREVIEW (P) plays the selection with the fix,
    looping if LOOP is on; BYPASS flips to the original in step so you can compare; RENDER (↩) applies it.
    INSTANT (off by default) renders as soon as a selection is drawn, like RX's instant process.
  - ATTENUATE gains RX's Direction (before/after, above/below for steady tones and whistles, or both),
    Surround length and a before ↔ after tilt; REPLACE has Surround and tilt too.
  - New DE-NOISE: select a stretch of just the noise, LEARN, then RENDER cleans the whole clip (or a
    selection) with Reduction, Threshold and Smoothing.
  - DE-HUM has Base (auto / 50 / 60) and Harmonics; DE-CLICK has Sensitivity.
  - INVERT (⌘I) selects everything except what you drew; ⌘A selects all.
- **Spectral editor** (right-click an audio clip › Spectral edit…, SPECTRAL… in the Inspector's Audio
  section, or ⌥⌘S), in the spirit of iZotope RX and Audition's Spectral Frequency Display: the clip's
  sound as a spectrogram (log/linear, Amber/Magma/Mono colours, FFT 1024–8192, dynamic range, waveform
  overlay), wheel zooms time, ⌥-wheel zooms pitch. Selections: TIME, FREQ, BOX, LASSO, BRUSH (⇧ adds),
  feathered edges and HARMONICS ×2…×6 to catch a voice's or a hum's overtones. Fixes: ATTENUATE (to the
  level around it), HEAL (rebuild from both sides), GAIN, REMOVE, KEEP ONLY, plus DE-HUM (auto 50/60 Hz
  and harmonics, with 3 Hz-narrow notches) and DE-CLICK. Space plays the selection; A/B compares with the
  original; every edit is listed and can be removed on its own (⌘Z for the last). APPLY renders a new
  WAV for the clip and keeps the original, so reopening lets you change or remove the edits. A video
  clip's sound is detached first so the picture stays untouched.
- **Voice over** (🎙 VOICE OVER on the tool strip, ⇧⌘R): a small floating panel with your mic, a level
  meter, a 3-2-1 countdown and RECORD. The edit plays from the playhead while you talk; the take lands on a
  Voice-over track exactly where you said it (input and output latency taken out). Space or STOP ends it,
  Esc throws it away; *Mute the edit* keeps the speakers out of the mic when you're not on headphones.
- **Punch in** (⇧⌘P, or PUNCH IN in the panel): mark In (I) and Out (O), and Reel plays a pre-roll of the
  old take, records, plays a short post-roll, then replaces only In→Out with 12 ms crossfades. Every take
  stays in the media list, and ⌘Z puts the old one back.
- **Settings (⌘,)**: pick the microphone (with a live level meter; the Record window starts with it)
  and where Reel plays its sound (Focusrite, headphones, AirPods…) with a TEST TONE. The output is the
  same as SOUND's MONITOR OUT; devices plugged in later appear by themselves.
- **SOUND is now a console**, laid out like an SSL / Allen & Heath desk: one channel strip per app,
  top to bottom: TRIM (+12 dB) and high-pass filter; a four-band EQ (HF shelf red, HMF green and LMF blue
  with frequency sweeps, LF shelf) with EQ IN; ROUTE (which speakers or headphones) and PAN in the
  middle; MUTE and SOLO; a long-throw fader with a real fader law (−∞ … 0 … +10 dB) and a green /
  yellow / red LED ladder; a white scribble strip with the app's name and icon. Knobs: drag up/down
  (⇧ fine), scroll, double-click to reset; the green LCD shows the control you're touching. The audio
  helper gained pan and a proper parametric strip EQ (RBJ shelves, peaks and a high-pass) next to the
  old 10-band EQ (a GEQ button appears where that's still on, to switch it off).
- The master section is Reel's own **monitor**: EQ, balance, mute, output device and a red master
  fader with meters. It shapes only what you hear while editing, never the export.
- macOS sound services and app helpers (com.apple.*, …Helper, arkaudiod…) are hidden; SYSTEM shows them.
  Solo is lifted when you close SOUND, so it never sticks.
- **ERNIE "isn't downloaded" when it is**: Reel now looks in every Hugging Face cache location (Studio's
  chosen folder, HF_HUB_CACHE, HF_HOME, ~/.cache) and, when it still can't find or read the model,
  says where it looked and why instead of asking you to download it again.
- **◀▶ MAX IN** next to the timeline zoom: zooms all the way in around the playhead (single frames);
  click again to go back. FIT ALL stays the all-the-way-out button. View menu: ⇧⌘=.
- **Press and hold SELECT** (or right-click it) for a menu: Select tool, Select all, All video, All
  audio, All text and titles, All pictures, All callouts/arrows/drawings, Everything on a track, from
  the playhead on, or before it, and Select none. Each shows how many clips it picks; drag any one of
  them (or ⌥← ⌥→) to move them all together.
- **Smart Zoom** (the tool strip's SMART ZOOM, was AUTO ZOOM) now works on **any video**, not just Reel
  recordings: it watches the picture, finds where things move, where the shots cut (to the frame) and
  where the detail is, and adds zoom and pan actions. Styles: *Follow the action* (tutorials),
  *Punchy* (social: quick punch-ins and jump zooms on cuts) and *Cinematic* (old footage: slow Ken Burns
  pushes). Amount slider, selected clips or every video, and an option to do it by itself for every
  video dropped on the timeline. Picture-in-picture clips zoom inside their own box; Reel recordings
  can still follow the pointer. Every zoom is an ordinary action you can adjust or delete.
- **Zoom the preview with the mouse wheel or a trackpad pinch**, around the pointer (25%–800%; it
  snaps to Fit and 100% on the way through). When zoomed in, drag the empty area around the picture,
  middle-drag, scroll sideways or ⇧-scroll to pan; double-click the empty area to fit. The size menu
  gains 25%, 200% and 400% and shows the wheel's zoom.

### Spectral editor: the rest of the RX toolkit
Reel's own processing (nothing taken from iZotope), each checked by a test on a sound built to have that problem:
- **De-plosive**: takes the thump out of P and B sounds, pops and mic knocks (sensitivity, strength, frequency limit).
- **De-wind**: flattens gusts and buffeting below a cutoff while steady low sound stays.
- **Mouth De-click**: lip smacks and tongue clicks (sensitivity, frequency skew, click widening).
- **De-ess**: classic (whole band) or spectral (only the harsh peaks); threshold, cutoff, speed.
- **Breath Control**: finds breaths between words; turns them down by a gain or to a target level.
- **Dialogue Isolate**: keeps the voice, turns traffic, crowds and rooms down.
- **Spectral Recovery**: finds where the highs were cut off (phone, Zoom, low-bitrate files) and rebuilds them.
- **Ambience Match**: LEARN a room tone, then fill a selection with it or fill every dead gap in the clip.
- **Pattern** and **Partials + Noise** repair modes: fill a hole from the best-matching stretch nearby, or carry
  tones straight across it (exact frequency, level and phase on both sides) over healed noise.
- **Find Similar** (⌘F): select one click, cough or beep and every similar one is selected; ◀ ▶ visit them.
- **Δ REMOVED**: while previewing, hear only what the fix takes out.
- The chosen module's settings sit in their own column beside the rack, so every module stays in view.

### Spectral editor: restoration in the CEDAR tradition
Reel's own processing, designed from what CEDAR's tools are documented to do (nothing taken from CEDAR), each tested:
- **GAIN** now sets a level inside the selection and another outside it (outside at −∞ keeps only the selection).
- **PATCH**: select a good stretch, SET SOURCE, select the bad spot; optional retune in semitones (clean resampling).
- **REVERT**: paint any area back to the original sound, keeping every edit outside it.
- **DE-CLIP**: redraws flattened peaks, including clipping that was compressed afterwards; output gain for headroom.
- **DECRACKLE**: low-level crackle and grit under what DE-CLICK catches.
- **AUTO DEHISS**: hiss reduction with no LEARN step (tracks the noise); Attenuation, Bias, LF bias.
- **DE-BUZZ**: hum and buzz up to 500 Hz, followed frame by frame when its pitch wanders.
- **DETHUMP**: replaces bumps and handling thumps with the low end that belongs there (ignores voices starting).
- **DE-BARK**: finds dog barks (automatically, or every bark like one you select) and pulls just the bark down,
  keeping the voice under it.
- **DIALOGUE ISOLATE** gains six band trims (bass to air), like a dialogue noise suppressor's band faders.
- REPLACE now bridges each separate part of a selection from its own surroundings (it treated them as one before).

### Import ScreenFlow projects
Drop a `.screenflow` project onto Reel (or choose it in Import) and it comes in already laid out:
- **Recordings** are converted: the screen to H.264 MP4 (ScreenFlow's own screen codec decoded by Reel: changed
  regions, block maps, flat / transform-coded blocks), the sound to WAV (ScreenFlow's lossless coder decoded), with
  the project's per-input mix applied (e.g. a mic on input 1 of a Scarlett plays in both ears).
- **The pointer** comes across as a separate track (positions, clicks, the window in front), so Reel draws it with
  its own pointer options instead of it being baked into the picture.
- **The timeline:** tracks in ScreenFlow's stacking order, clips with their timing, trims, speed, position, scale,
  rotation, opacity, crop and volume; cross-transitions (overlapping clips get a lane of their own with the fade);
  text with font, size, colour, alignment and background; zoom / pan video actions as keyframes; callouts
  (freehand area, pointer or front window) with dim, zoom, blur and outline; markers.
- Works with projects from every ScreenFlow document version (the format of each is built in). The canvas is set to
  the project's size when Reel's timeline is empty.
- Flattened `.screenflowf` files: Reel asks for a normal Save As first.

### Speed, the ScreenFlow way (and better)
- **Clip panel** laid out like ScreenFlow's Clip Inspector: Duration (type a length and the speed fits it),
  Speed as a slider (fine around 100 %, 5 % to 2000 %) and a typed %, preset chips, Keep pitch, Source duration,
  Play clip in reverse and Locked.
- **⌘-drag a clip's edge** to change its speed by eye (live % · × · length readout); plain drag still trims,
  ⌥-drag still rolls.
- **Speed Up ⌥⌘.**, **Slow Down ⌥⌘,**, **Speed…** and **Normal Speed** in the Edit menu and the clip menu, for
  every selected clip. Keyframes, actions and fades stretch with the clip; it never runs into the next clip.
- **⚙ on the selected clip** opens the clip menu (ScreenFlow's gear).
- **Export keeps the pitch** of sped-up or slowed sound (WSOLA time stretch), as the preview always did; turn
  Keep pitch off for the tape-style effect.
- ScreenFlow import: freehand callouts drawn with the square come in as rectangles (circles as ovals).

### Time-lapse presets
- **TIME-LAPSE** on the tool strip and Edit › Time-lapse…: pick a preset (YouTube 60 s / 3 min, Shorts 30 s,
  art time-lapse, skip the idle parts, fit a length, even speed) or type a length. Busy stretches (cursor,
  typing, picture changes, speech) play slower; idle stretches race through. Sound can be muted or kept at the
  same pitch, and Smart Zoom can follow the action in the same step.

### ADR: Align to Guide
- Select the re-recorded line and the original production dialogue and choose **Align to Guide (ADR)… ⌥⌘A**
  (Clip menu, or the clip menu when two clips are selected). The new take is matched to the guide syllable by
  syllable and re-timed onto it, pitch kept, so it fits the lips. Tightness (loose / normal / tight), a limit on
  how much speech may stretch (pauses can grow or shrink freely), and an option to mute the guide afterwards.
- A new aligned file is written; the original take is kept. Choose the command again on the aligned clip to
  restore the original take.

## 1.2.0 — ScreenFlow feel, round 2
- Tools: **A** select, **T** blade (click a clip to cut it where you click; ⌥-click cuts only that clip).
  SELECT / BLADE keys on the tool strip; a white line shows where the blade will cut.
- Canvas: eight handles; hold **⌥ Option** to turn them into crop handles (what's left stays in place).
  Moving and resizing snap to the frame's centre and edges, with pink guide lines.
- Fades: drag the little squares at the top corners of a clip to fade it in or out (sound and picture).
- Right-click menus on clips, keyframes, actions, clip markers, empty timeline and the canvas selection
  (delete keyframes or actions, fades, splice here, reverse, detach audio, lock, group, centre / fit / fill…).
- Transport: FRAME ◀ ▶ while playing shuttle 2× / 4× / 8× forward or rewind (J / L too); PLAY returns
  to normal. Grab either reel and turn it to scrub picture and sound.
- Inspector: ALL · VIDEO · AUDIO · MOTION · SCREEN · CALLOUT · TEXT · FX keys to show one kind of setting.
- Callout magnify goes to 10×.
- Projects: ⏏ CLOSE in the header (⌘W); ⌘-click / ⇧-click to pick several projects and move them to the Trash.
- AI Image: GENERATE explains right under it why it can't paint yet (and checks again when pressed);
  a small live preview shows the picture forming.
- Fixes: Play in Reverse on sound clips (now a WAV, with real progress); pan showed "RNaN" on older
  projects; the deck no longer spills over the inspector on narrower windows; the home-screen tape runs
  behind the reels.

## Reel-to-reel look
- The transport is now a tape deck: supply and take-up reels whose tape packs follow the playhead and
  turn while playing or scrubbing, piano-key transport buttons (PLAY latches down and lights green),
  a tape counter, two needle VU meters reading the preview mix, and a 3¾ · 7½ · 15 ips speed switch
  (½×, normal, 2× preview). The home screen carries a turning reel pair.
- Automation points: double-click, ⌫, or right-click › Delete point; right-click for curve shape.
- Idea notes turn dark slate with a blue outline on hover.
- Floating rack-style REC panel with STOP while recording; delete projects from the home screen.

## FLUX.2 [klein] as a second picture engine
- AI Image and Thumbnail Studio: ENGINE switch, ERNIE or FLUX. FLUX.2 [klein] 4B (Black Forest
  Labs, Apache 2.0) follows long, detailed prompts closely; 4 steps.
- Uses the 4-bit copy Protoart Studio already downloads (same pinned revision, shared cache, 4.4 GB);
  GET FLUX downloads it on a Mac where Studio hasn't.
- Built for 8 GB Macs like Studio: the text encoder is dropped once the prompt is encoded, prompts
  are cached across variations, LoRAs stay unbaked add-ons, only one picture engine is in memory at a
  time, and both unload 90 s after use on small Macs. Starting from a frame uses klein's edit mode.
- FLUX.2 LoRAs come from Protoart Studio's "FLUX.2" LoRA folder.

## ScreenFlow parity, round 1
- EXPLAIN button in the header (⌘/): rest the pointer on anything to see what it does.
- Timeline: rolling edit (⌥-drag where two clips touch), close gap on a track / on all tracks, close
  every gap on a track, insert a gap, ripple-delete In→Out or between markers, clip markers (⇧M),
  colour labels.
- Media library: search, kind / unused filter, rename, replace file, show in Finder, select clips
  using it, Global Library for media every project can use.
- Export: format, size, frame rate and quality settings; your own presets; iPhone / iPad and App Store
  presets; animated GIF and animated PNG (our own encoders, only changed areas stored); batch export
  to a folder; size and time estimate.
- File: Save as Template, New from Template (also on the home screen), Archive Project.

## Fixes from the first hands-on test
- Scrubbing: the sound no longer keeps playing after you let go; the picture no longer flickers
  (seeks are queued one at a time and the last frame stays up while the next one decodes).
- Typing in any text box no longer starts playback or triggers single-key shortcuts (Space, S, M, I,
  O, [, ], ⌫ were menu shortcuts that macOS fired even while typing; ⌥X / ⌥F now work on Mac keyboards).
- AI Image: picture on top, the three modules side by side in a vertical rack; notes and warnings
  are set in a clear typeface, dark on the tape.

## 1.1.0 (in progress)

- Voice Clean and DeReverb built in (RNNoise + our own late-reverb suppressor), per clip, with presets.
- Audio Unit hosting for clips and the master (out of process), e.g. CEDAR and Waves.
- Master: TG-style finishing chain, BS.1770 loudness targets and a true-peak limiter at export.
- Per-app recording and Sound mixer (Core Audio process taps).
- Thumbnail Studio: 9 size presets, 14 channel types with title looks, badges and picture ideas,
  ERNIE LoRA styles, add the thumbnail to the project.
- AI Image: generate pictures for the edit and add them to media or the timeline.
- Keyframes: ◆ next to position, scale, rotation, opacity, callout, text size, volume and pan sets a
  keyframe at the playhead; diamonds on clips (drag to retime, ⌥-click to delete); linear/smooth/hold.
- Track panel like Pro Tools / Audition: solo, mute, hide, volume and pan knobs, and automation lanes
  (volume, pan) with Read / Touch / Off modes; applied in preview and export.
- Scrub: drag the playhead or ruler, also while playing (playback continues where you let go); SCRUB
  toggle to hear the sound while dragging.
- Selection: ⌘A selects all, ⇧⌘A everything after the playhead, drag a box on empty timeline space,
  ⌥← ⌥→ nudge by a frame (⇧ for a second); dragging any selected clip moves them all.
- Zoom: − / + buttons and FIT ALL (⌘0) zoom all the way out to the whole project, however long.
- Fixed: some MP4s (negative frame offsets in a version-0 ctts) showed as hundreds of hours long;
  projects that saved the wrong length are repaired when opened.
- HELP moved to the top bar.
- Stage A (ScreenFlow parity): freeze frame (⌥F) that keeps every track in sync; play in reverse
  (⌥⌘R) via a reversed copy rendered in small windows (bounded memory); detach audio (⌃⇧S); lock
  (⌘L); group / ungroup (⌥⌘G); trim front / end to playhead ([ ]); mark in / out (I, O, ⌥X) with
  "In to Out" export; copy style / paste style / paste properties (⌥⌘C, ⌥⌘V, ⇧⌘V); save frame
  (⌥⌘F); delete unused media; SMPTE timecode and track height in the View menu. AI Image moved to ⌥⌘I.
- Stage B (screen-recording polish): record clicks (and, only if you turn it on, keystrokes) through a
  listen-only input monitor; click effects (ring, ripple, dot; right-click colour) and click sounds in
  preview and export; keystroke display (style, position, shortcuts only, hold time); "keep the pointer
  editable" recordings with a drawn pointer you can hide, enlarge or swap (when macOS honours it);
  callouts that follow the pointer, freehand callouts drawn on the preview, build in / out timing;
  snapback actions (⇧⌘K); recording "stop after" timer.
- Stage C (text, captions, titles): caption lane with SRT / WebVTT import and export, burn-in option
  and an .srt saved beside exported movies; letter-by-letter text animations (build, build scale,
  fade letters, character flip, gravity, move into place, break apart, bounce) with adjustable length;
  9 title templates with live previews; saved text styles (any project); annotation clips you draw on
  the preview that draw themselves on; speech from text with the Mac's own voices (offline); fill
  opacity for boxes. Toolbar: one + INSERT menu, and the header fits a 13-inch screen.
- Stage D (picture): GPU filter stack (one WebGL pass) in preview and export — colour (exposure,
  contrast, highlights, shadows, saturation, vibrance, temperature, tint), 8 built-in looks, .cube
  LUTs (copied into the project), sharpen, blur, vignette, black & white, green screen with spill
  removal and an eyedropper; background removal for people via Apple Vision (a mask video made once,
  on the Neural Engine); motion blur on export. Filters render at no more than the size shown.
- Studio-gear finish to match ProtoArt Press and Wake: brushed black faceplate, screws, lamps, bakelite
  buttons and fader caps, seven-segment timecode, rack-module windows, masking-tape notes.

## 1.0.0: PR-1 first version

- Recorder: screen or window, camera, microphone and computer audio to separate files; pointer track.
- Editor: tracks, trim/split/ripple, snapping, markers, undo; clip transforms, crop, corners, shadow,
  border; actions (zoom & pan) and Auto zoom; text, callouts, arrows; transitions; speed; audio fades,
  mute, ducking.
- Thumbnail Studio with ERNIE-Image Turbo (text-to-image and image-to-image from a frame) and prompt
  suggestions, using Protoart Studio's installed engines.
- Export: H.264 / HEVC + AAC MP4 or AAC audio with WebCodecs and our own MP4 muxer.
