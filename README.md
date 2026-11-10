# ProtoArt Reel

**Record your screen, camera and sound. Edit. Make a thumbnail with ERNIE. Export.**

ProtoArt Reel is a macOS screen recorder and video editor in the spirit of ScreenFlow, with a Thumbnail
Studio that paints thumbnail art with ERNIE-Image Turbo on your own Mac. Everything stays on your Mac:
no accounts, no uploads, no network connections.

## Download

Get the DMG from the [latest release](https://github.com/theprotoart/protoart-reel/releases/latest).
Apple silicon Macs (M1 or newer). It isn't
notarised yet: the first time, open it from **System Settings → Privacy & Security → Open Anyway**.

## Features

- **Recording:** any screen or window, camera, microphone and computer audio, each saved to its own
  file (H.264 MP4 for picture, lossless WAV for sound) so they can be edited separately. 3-second
  countdown, Reel hides while recording, stop with ⇧⌘2 or the menu-bar icon. The pointer position is
  recorded as well.
- **Editing:** multi-track timeline with move, trim, split, ripple delete, snapping, markers, undo.
  Position, scale, crop, rotation, opacity, rounded corners, shadow and border per clip, with
  picture-in-picture presets. **Actions** animate any of these (zoom & pan); **Auto zoom** creates them
  from the recorded pointer. Text with animations, callouts (spotlight, blur, magnify), arrows and boxes,
  transitions, speed changes, audio volume/fades/mute and voice ducking.
- **Keyframes and automation:** ◆ beside a slider sets a keyframe at the playhead; callouts, position,
  scale, opacity, text size, volume and pan can all move over time. Each track has solo, mute, volume
  and pan, and volume/pan automation lanes you draw with the mouse or record with Touch mode.
- **Voice tools (built in):** Voice Clean (noise removal with RNNoise, a small neural network that runs
  on the CPU in real time) and DeReverb (takes the room echo off a voice), with presets, a 10-band
  shaper, Listen and A/B. Rendered once per clip, so playback and export stay fast.
- **Your own plug-ins (optional):** any Audio Unit on your Mac (CEDAR, Waves, iZotope, FabFilter…) can be
  added to a clip or to the master, with its own window for settings. They run in a separate process, so a
  plug-in that crashes can't take Reel down. Licensed plug-ins need their licence manager (e.g. iLok
  License Manager) as usual.
- **Master (finishing for export):** a TG-style mastering chain (input, tone, compressor/limiter,
  filters, stereo spread) with presets, a loudness target (YouTube −14, Apple Podcasts −16, Broadcast
  −23 LUFS…) measured to ITU BS.1770, and a true-peak limiter.
- **Thumbnail Studio:** sizes for YouTube (1280×720, 1920×1080), Shorts/TikTok/Reels covers, Instagram,
  Facebook/LinkedIn, X, podcast covers and channel banners. Pick your kind of channel (art, cooking,
  gaming, tech, fitness, travel, music, education, beauty, money, DIY, podcast, kids, screen tutorial)
  for a matching title look, badges and ready-made picture ideas; paint art with ERNIE-Image Turbo from
  a prompt or over a frame, with your ERNIE LoRA styles from Protoart Studio; add a big title, badge and
  framed screenshot; save PNG/JPG or add it to the project as an intro/end card.
- **AI Image:** make pictures for the edit itself (backgrounds, B-roll stills, title cards) in the
  project's size, 16:9, 9:16, square or any thumbnail size; add them to media or straight onto the
  timeline at the playhead.
- **Per-app sound (Loopback / SoundSource style, no driver):** record only the apps you choose, each on
  its own track; and a Sound mixer with per-app volume up to 400%, mute, 10-band EQ with presets and
  output device. Uses macOS's Core Audio process taps (macOS 14.2+) through a small built-in helper.
- **Export:** H.264 or HEVC + AAC with Apple's hardware encoders, exactly as the preview shows, or audio
  only. Markers become YouTube chapter text.

## Requirements

- A Mac with Apple Silicon (M1 or newer), macOS 13 or newer (computer audio needs macOS 13).
- For ERNIE thumbnails and smart prompts: Protoart Studio installed on the same Mac with its fast
  engine and ERNIE-Image Turbo (fast engine) downloaded. LoRA styles are read from Protoart Studio's
  ERNIE LoRA folder. Without them, the Thumbnail Studio still works with video frames and titles.
- For Kitten voices (natural speech and cloning your own voice): Python 3.10 or newer on the Mac
  (Protoart Studio's, or python.org's 3.12). Reel downloads the voices once (about 3 GB) when you press
  GET KITTEN VOICES; FLUX and the writer's Qwen models download only when you press their GET buttons.

## About the audio features

Loopback and SoundSource install a system audio driver. Reel doesn't: it uses Core Audio process taps, so
nothing is installed and it stops when Reel quits. One thing that needs a driver isn't possible this
way: making a virtual microphone that other apps (Zoom, OBS…) can pick as an input.

## Projects

Projects are saved in `Movies/ProtoArt Reel`, one `.reel` package per project with its recordings and
imported media inside (`project.json` + `media/`). Reel saves automatically every minute.

## Build

`Build ProtoArt Reel.command` (double-click) builds `ProtoArt Reel.app`; `Make DMG for friends.command`
runs the tests, builds and packs a DMG. `npm test` runs the tests.
