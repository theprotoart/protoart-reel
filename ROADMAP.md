# ProtoArt Reel roadmap: ScreenFlow parity, CapCut ideas, M1 / 8 GB

Source of the ScreenFlow list: ScreenFlow.app on this Mac, read with REA (interface-file decode of
the app bundle) plus the app's own English menu and inspector strings and bundled resources. Hopper-
based code analysis is still blocked by Hopper's licence dialog. Nothing of ScreenFlow's is copied;
this is a feature checklist only.

## Already in Reel
Screen/window, camera, mic, computer audio and per-app recording; multi-track timeline (split, ripple,
snap, markers → chapters, select all / after playhead, marquee, nudge); zoom & pan actions and auto
zoom from the pointer; callouts (box/ellipse, dim, blur, magnify, outline); text with fade/slide/pop/
typewriter; arrows and boxes; transitions; speed; pointer highlight and smoothing; keyframes on
position, callouts, text size, volume and pan; track solo/mute/volume/pan and automation lanes;
voice clean, dereverb, Audio Unit plug-ins, mastering with loudness targets; H.264/HEVC export;
Thumbnail Studio and AI Image with ERNIE and LoRAs.

## Moving to Rust, one piece at a time
Reel stays an Electron app that keeps shipping, while its heavy work moves into `reel-core`, a Rust helper
with no third-party crates. Each piece moves only with a test that runs the JavaScript and the Rust on the
same input and checks they agree, and the build ships a piece only if that test passes (otherwise the
JavaScript runs, as before). When little JavaScript is left, the window itself can follow.

1. **Done: the bridge and the um detector.** `native/reel-core`, `tools/Get Rust.command`, the build step,
   `app/engine/core.js`, and finding your ums by ear (same answers, about 3× faster on two cores and off the
   editor's thread so it doesn't stall).
2. **Done: sound analysis, reading the files itself.** The core opens a media file and gives the timeline's
   waveform and AUTO MIX's loudness profile in one pass: WAV in Rust, AAC and the rest through Apple's own
   decoder (AudioToolbox), not the browser's. Identical to the JavaScript on WAV (to the bit), within 0.5 LU on
   AAC; about 2.7× faster on two cores. (This is also step 4's start: decoding without the browser.)
3. **Done (first part): sound-only export.** The core mixes and writes it: every clip's sound, its volume, fades,
   pan, keyframes and automation (worked out by Reel, in lib/mixplan.js), the mix bus gain and limiter and the
   export's soft limit, as 24-bit WAV or as AAC by Apple's encoder. The same file as the JavaScript export, to
   the 24-bit sample; about 2.2× faster. **Loudness targets too** (0.6): the core measures the mix (BS.1770-4,
   gated), turns it to the target and runs the true-peak limiter; identical to the JavaScript master path, sample
   for sample, with no temporary mix file. **Click sounds too** (0.7), and **sped-up clips that keep their pitch** (0.8). Still in JavaScript, and used automatically when a project needs them:
   track effects, other mix bus effects, the built-in master chain and master plug-ins, and time maps. They move next, one at a time, then picture export (step 5) can use it.
4. **Decoding:** read sound and video straight from the files through Apple's frameworks.
5. **Picture export:** drawing every frame and encoding H.264 / HEVC (VideoToolbox) in Rust.
6. **Recording:** screen, window and camera through ScreenCaptureKit.
7. **The window:** a plain Rust interface (egui or Slint), once the pieces above no longer need the browser.

## ScreenFlow features still to build (gear look throughout)
**Stage A: editing basics — done**
Freeze frame, play in reverse, lock, group, detach audio, mark in/out, trim to playhead, copy/paste
style and properties, save frame, delete unused media, SMPTE timecode, track height.
Still open from this stage: *nesting* (a group of clips folded into one clip you can open and edit).

**Stage B: screen-recording polish — done**
Clicks and keystrokes recorded; click effects and sounds; keystroke display; editable pointer; callouts
that follow the pointer, freehand callouts, build in/out; snapback actions; stop-after timer; adding
another recording to a project (REC while a project is open).
Still open: *foreground-window callouts* (needs window positions recorded) and *loop recording*.

**Stage C: text, captions, titles — done**
Caption lane with SRT/VTT import & export, burn-in, .srt beside exports; letter animations; title
templates; saved text styles; annotation drawings; speech from text (macOS voices).
Still open: captions as a soft-subtitle track *inside* the MP4 (the .srt beside it covers YouTube).

**Stage D: picture — done**
GPU filters (colour, looks, LUTs, sharpen, blur, vignette, B&W), green screen, background removal
(Apple Vision), motion blur on export.
Still open: letterbox / fill choice when the export shape differs from the canvas.

**Stage E: export and library**
- Export presets, batch export, GIF/APNG, chapter and captions tracks in the MP4
- Templates (save a project as a template); media library
- Proxy media for 4K / Retina recordings (also the biggest speed win on 8 GB)

## ScreenFlow 10 checklist (from Telestream's User Guide, product sheet and resources page)
✅ in Reel · 🔜 next · ✖ not planned (reason)

**Recording**
✅ screen / window / part of the screen, camera, mic, computer audio, per-app audio · ✅ countdown ·
✅ stop-after timer · ✅ clicks and keystrokes · ✅ add a recording to an open project ·
🔜 pause / resume while recording · 🔜 add markers while recording (a key) · 🔜 recording monitor
(levels while recording) · 🔜 iPhone / iPad screen recording over USB, with touch callouts ·
🔜 up to 16 audio inputs (multi-channel interfaces) · ✖ Telestream Audio driver (Reel uses Apple's
own system-audio capture and the reel-audio helper instead)

**Editing**
✅ canvas move / scale / crop / rotate · ✅ tracks: add, delete, solo, mute, hide, volume, pan,
automation · ✅ markers, in / out points · ✅ split, trim, ripple, rolling edit (⌥-drag a cut) ·
✅ close gap on one track / all tracks, close every gap, insert a gap · ✅ delete between in & out
or between markers (ripple) · ✅ clip markers · ✅ colour labels · ✅ custom clip names ·
✅ speed · ✅ group / ungroup · ✅ lock · ✅ freeze frame · ✅ transitions · ✅ snapback ·
✅ video filters, LUTs, chroma key, background removal · ✅ audio filters, ducking, plug-ins ·
✅ text, titles, lower thirds, text animation, style presets · ✅ annotations, freehand callouts ·
✅ callouts, zoom & pan, motion (keyframes) · ✅ captions: edit, timing, SRT / VTT in and out ·
🔜 nested clips · 🔜 canvas crop (export only part of the canvas) · 🔜 caption language ·
🔜 automatic captions from speech (on-device, Apple Speech) · 🔜 narration: record a voice-over
while the timeline plays · 🔜 detachable timeline window · 🔜 customizable toolbar

**Media library**
✅ add, delete, delete unused · ✅ search and filter by kind / unused · ✅ rename · ✅ replace file
(relink) · ✅ show in Finder · ✅ select clips using it · ✅ Global Library shared by every project ·
✖ No stock-media library, by choice: Reel ships with no stock content. Your own media goes in the
Global Library, and AI Image makes backgrounds and stills

**Export and sharing**
✅ H.264 / HEVC MP4, sound-only M4A · ✅ built-in presets incl. iPhone / iPad and App Store preview ·
✅ save your own presets · ✅ animated GIF and animated PNG of a range · ✅ batch export to a folder ·
✅ frame-rate choice · ✅ size and time estimate · ✅ .srt beside the movie · ✅ chapters from markers ·
🔜 MOV / M4V containers · 🔜 captions and chapters inside the MP4 ·
✖ Publish to YouTube / Vimeo / Wistia / Box / Dropbox / Google Drive / Imgur for now: each needs
an app registered with that service and your sign-in; export + upload in the browser meanwhile

**Projects and settings**
✅ templates (save as / new from) · ✅ archive project (only used media) · ✅ Explain mode ·
🔜 keyboard shortcut editor · 🔜 proxy media for 4K / Retina recordings · 🔜 default document
settings (canvas, frame rate) in a Settings window

## CapCut-style ideas (adapted to the gear look)
- **Auto captions** from the voice, with animated caption styles (word highlight, pop), run on-device
- **Silence / filler cut**: one button removes pauses from narration (jump cuts)
- **Auto reframe to 9:16** following the recorded pointer, with blurred-background fill
- **Speed ramps** (curves), **beat markers** from music, **text templates** and **effect presets**
  with an intensity knob; **one-tap enhance** (voice + loudness + colour)

## M1 with 8 GB of RAM
Done: hardware H.264/HEVC encode and decode (VideoToolbox through WebCodecs); export streams in
chunks rather than holding the movie in memory; native audio helpers; AI models unload 90 s after
use and before recording or export on Macs with 16 GB or less; the preview keeps at most a handful
of video decoders alive.
To do: proxy media; measure real memory on an 8 GB M1 (Activity Monitor during record, edit, export,
ERNIE); lazy-load heavy windows; trim the Electron bundle (~250 MB is the floor for an Electron app).
ERNIE on 8 GB works in low-RAM mode but is slow and pushes the Mac into swap; best done while
nothing else heavy is open.
