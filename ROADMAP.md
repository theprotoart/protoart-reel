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
   for sample, with no temporary mix file. **Click sounds too** (0.7), **sped-up clips that keep their pitch** (0.8), **track and mix-bus effects** (0.9), and **the built-in master** (1.0), and **time maps** (1.1: Elastic Wave and retime curves, pitch kept or like
   tape). Still in JavaScript, and used automatically when a project needs them: master plug-ins (Audio Units,
   which only macOS can run, so they stay with the Mac's own audio helper). Click sounds on a clip with a time map
   and the master's De-click joined in 1.15. Next: picture export (step 5), starting with the frame drawing.
4. **Decoding:** read sound and video straight from the files through Apple's frameworks.
5. **Picture export:** drawing every frame and encoding H.264 / HEVC (VideoToolbox) in Rust.
   - **Done (1.2): the container.** The core reads MP4 and MOV files itself (every track, codec and decoder
     description, and every frame's place, timing and keyframe flag; fragmented files, edit lists, B-frames, turned
     phone videos) and writes the export's MP4. Checked against the JavaScript on real H.264, HEVC, MOV and
     fragmented files, sample for sample, and the written file byte for byte.
   - **Done (1.3–1.13): drawing and encoding.** Frames decoded by the Mac (VideoToolbox), drawn by the core (placed,
     scaled, cropped, turned, faded, rounded, bordered, shadowed, blurred, colour filters and green screen, pointer
     effects, the pointer magnifier), titles, call-outs and graphics laid over as the editor draws them, magnifying
     and blurring call-outs, shaped transitions (wipes, iris, clock, barn doors, blinds), motion blur, background
     graphics and device frames (the editor draws them into their place in the core's stack), LUT files and
     background removal, and the sound
     mixed and mastered; encoded by VideoToolbox. Each checked frame by frame against the editor's own drawing.
   - **Done (1.14): every export through the core.** The moments the core can't draw itself yet (the text reveal,
     the transitions that read the picture: glitch, film burn, light leak, vertigo, radial shutter; a turned phone
     video, an SVG or GIF, a clip played backwards) are drawn whole by the editor, exactly as its own export draws
     them, and handed to the core in their place; the rest of the export stays the core's. Only an export that's
     mostly such moments goes the usual way.
   - **Done (1.14): the transitions that paint over the picture, in the core.** Light leak, film burn (and the vintage
     one's burning holes and flicker), glitch bars, the lens flare sweep, the fast wipe's streak, letterbox bars, the
     radial shutter (its iris and blades), film grain (transition or filter), and the two that move the picture
     about (glitch blocks, the vertigo ramp's hold): written down by lib/fxshapes.js from
     the editor's own drawing code (shared with it) and drawn by ink.rs with the canvas's blend modes. Each checked
     against the editor's drawing in Chrome (mostly within 1 level in 255; 40–55 dB).
   - **Done (1.14):** turned phone videos (the decoder's frames as stored, turned by the plan: the same to the pixel)
     and SVG and GIF pictures (a PNG of what the editor shows, made for the export and removed after).
   - **Done (1.15): long edits.** More than 48 clips: the export is cut into parts of up to 48 clip decoders each,
     run one after another into one encoder (the same output, byte for byte, as in one go).
   - **Done (1.15): the text reveal.** The editor draws only the words (white, into a slot the core reads as the
     cut) and their shadow (a slot under the clip); the core draws the clip through them (checked against the editor's
     drawing: PSNR 51–53 dB, worst 6/255).
   - **Done (1.15): transition effects on titles and graphics.** The titles up to one with a glitch, light leak,
     shutter… go into a slot, and the core paints the effects over it (same accuracy as on a clip).
   - **Done (1.15): filters on a turned phone video** (graded as stored, then turned, as the editor: the same to 1/255).
   - **Done (1.15):** a dip and transition effects at once on a title (the dip after the effects), a text reveal
     with a wipe at the same time (the editor cuts the words to the wipe).
   - Still the editor's (drawn whole and handed to the core): pointer effects on a turned phone video, a text
     reveal with a radial shutter at the same time — both rare.
   - **Done (1.16):** blur and exposure moves on a rounded, bordered, shadowed or stabilized picture (cut to the box after
     the filter; the box's shadow cast from the blurred box; the border filtered too).
   - **Done (1.16):** pointer effects on a bordered picture (the border drawn on its own, over them), and a device
     frame on a shadowed clip (the shadow on its own, under the frame); an older core leaves those to the editor.
   - **Done (1.15): on by default.**
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
Captions as a soft-subtitle track inside the MP4, and markers as chapters in it: done (1.15).

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
✅ pause / resume while recording · ✅ add markers while recording (⌥⇧⌘M) · ✅ recording monitor
(the mic's level on the floating panel, 1.15) · 🔜 iPhone / iPad screen recording over USB, with touch callouts ·
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
🔜 nested clips · 🔜 canvas crop (export only part of the canvas) · ✅ caption language (the speech's language) ·
✅ automatic captions from speech (on-device, Apple Speech) · ✅ narration: record a voice-over
while the timeline plays · 🔜 detachable timeline window · ✅ customizable toolbar (1.15: right-click it)

**Media library**
✅ add, delete, delete unused · ✅ search and filter by kind / unused · ✅ rename · ✅ replace file
(relink) · ✅ show in Finder · ✅ select clips using it · ✅ Global Library shared by every project ·
✖ No stock-media library, by choice: Reel ships with no stock content. Your own media goes in the
Global Library, and AI Image makes backgrounds and stills

**Export and sharing**
✅ H.264 / HEVC MP4, sound-only M4A · ✅ built-in presets incl. iPhone / iPad and App Store preview ·
✅ save your own presets · ✅ animated GIF and animated PNG of a range · ✅ batch export to a folder ·
✅ frame-rate choice · ✅ size and time estimate · ✅ .srt beside the movie · ✅ chapters from markers ·
✅ MOV / M4V (1.15: choose it in the save dialog) · ✅ captions and chapters inside the MP4 (1.15) ·
✖ Publish to YouTube / Vimeo / Wistia / Box / Dropbox / Google Drive / Imgur for now: each needs
an app registered with that service and your sign-in; export + upload in the browser meanwhile

**Projects and settings**
✅ templates (save as / new from) · ✅ archive project (only used media) · ✅ Explain mode ·
✅ keyboard shortcut editor · ✅ proxy media for 4K / Retina recordings · ✅ default document
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
