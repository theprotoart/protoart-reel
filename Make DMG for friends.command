#!/bin/bash
# Double-click to make a .dmg installer of ProtoArt Reel to share with friends.
# Builds a fresh app, checks it, and packs it with an Applications shortcut.
cd "$(dirname "$0")"
ROOT="$(pwd)"
APP_NAME="ProtoArt Reel"
APP="$ROOT/$APP_NAME.app"
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"
mkdir -p "$ROOT/dist"
DMG="$ROOT/dist/ProtoArt-Reel-${VERSION}.dmg"
LOG="$ROOT/dist/dmg-log.txt"
exec > >(tee "$LOG") 2>&1
step() { printf '\n== %s\n' "$*"; }
fail() { printf '\nSTATUS: FAILED (%s)\n' "$*"; read -r -p "Press Return to close this window." _; exit 1; }

step "Running tests"
if command -v node >/dev/null 2>&1; then
  node --test "$ROOT"/tests/*.test.mjs >/dev/null 2>&1 && echo "All tests passed." || fail "tests failed (run: npm test)"
else
  fail "Node.js is needed to run the tests"
fi

step "Building a fresh copy of the app"
bash "$ROOT/Build ProtoArt Reel.command" --no-open < /dev/null || fail "the build didn't finish"
[ -d "$APP" ] || fail "the build didn't produce $APP_NAME.app"

step "Checking it"
codesign --verify --deep --strict "$APP" >/dev/null 2>&1 && echo "Signature OK." || fail "the signature didn't verify"
[ -f "$APP/Contents/Resources/Licenses/LICENSES.chromium.html" ] && echo "License notices included." || fail "license notices missing"
ARCH="$(lipo -archs "$APP/Contents/MacOS/Electron" 2>/dev/null || file "$APP/Contents/MacOS/Electron")"
echo "Runs on: $ARCH"

step "Packing the DMG"
STAGE="$(mktemp -d)/$APP_NAME"
mkdir -p "$STAGE"
cp -cR "$APP" "$STAGE/" 2>/dev/null || cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
cat > "$STAGE/Read Me First.txt" <<'TXT'
ProtoArt Reel — test build for friends
=======================================

INSTALL
1. Drag "ProtoArt Reel" onto the Applications folder.
2. The first time, macOS will say it can't check the app (it isn't from the App Store).
   Open System Settings › Privacy & Security, scroll down, and click "Open Anyway"
   next to ProtoArt Reel. (On older macOS: right-click the app › Open › Open.)

FIRST RECORDING
- Press REC. macOS asks to allow Screen & System Audio Recording and the Microphone:
  press Allow, then quit Reel (⌘Q) and open it again so the permission takes effect.
- Turning on "Record clicks" or "Record keystrokes" also asks for Input Monitoring.
- While recording, the panel at the bottom of the screen has MARK, PAUSE and STOP
  (or ⌥⇧⌘M, ⌥⇧⌘2 and ⇧⌘2).

NEW IN THIS BUILD — PLEASE TRY (1.6.0: both 1.5.9 lines together)
- 🎵 Fit music: select a music clip › MUSIC tab › FIT TO THE VIDEO, or drag the ♪
  on its end; sections repeat or skip where the song repeats, real ending kept.
- 📝 Clap notes: clap, then say what should appear on screen (AUTO EDIT › Claps).
- 🎨 Match colour and ◐ colour wheels; ⤳ Retime curve; 〰 Elastic Wave.
- Text reveal transition; thumbnails from a frame; DaVinci-style picture handles.
- 🗣 VOICES and 🎙 CLONE MY VOICE (natural Kitten voices on your Mac).
- The panel on the right opens on AUDIO or VIDEO for what you pick.

EARLIER BUILDS
- HEAR PLUG-INS LIVE: in the MIXER, click + effect on a track › ★ Your plug-ins, then press
  SPACE. You hear that track through the plug-in while you turn its knobs. The banner at
  the top says LIVE (red lamp) when it's working. CLOSE PLUG-IN goes back to normal.
- CROSSFADES BY DRAGGING: drag a clip so it overlaps the one next to it on the same track
  and let go: they blend smoothly (sound and picture). Drag apart to remove it.
- Auto Level: evens out the volume (in Auto Edit, or right-click a track › Auto-level).
  Sound effects in Auto Edit can be Off, Quiet, Normal or Loud.
- + PLUG-IN in a clip's AUDIO tab: run your installed Waves / iZotope / FabFilter plug-ins.
- ⧓ TRANSITIONS: click the ⧓ on any cut between two clips to pick a transition; fades too.
- ✚ KEEP A PART: drag over the parts of a long video you want, then ⚡ AUTO EDIT blends them.
- Reel opens in SIMPLE mode: big buttons and a 1-2-3 guide (add a video, edit, export).
  Switch to FULL in the top bar for every tool. Start with EDIT A VIDEO.
- ⚡ AUTO EDIT: drop in a video, pick TikTok, Shorts, a podcast clip or a YouTube video,
  and Reel edits it for you (best moments, vertical, zooms, transitions, captions).
- ★ PRESETS: transitions, cut transitions, title animations, motion presets, animated
  elements (lower thirds, subscribe button…) and sound effects, with live previews.
- MIXER: a channel for every track (EQ, effects, pan, mute, solo). The fx button on a
  track opens its effects rack.
- Light mode: View › Light / Dark (Shift-Cmd-L).
- CAPTIONS and TEXT EDIT: auto captions, and editing by deleting words from a transcript.
- VERTICAL: re-frames a video for Shorts / Reels / TikTok.
- SPECTRAL: repair sound (de-noise, de-click, de-bark…), even on hour-long files.
- Drag a ScreenFlow project (.screenflow) onto Reel to open it.
- ADR: select a new take and the original line, then press ADR to line them up.
- Drag a track up or down by its ☰ grip or its name. Right-click a track for more.
- Right-click an effect in the MIXER (or click its ×) to remove it.
- Pick your audio interface in Settings › Audio Hardware; playback goes straight there.
- VERTICAL now shows a before / after picture of your frame before you commit.

GOOD TO KNOW
- Needs a Mac with Apple silicon (M1 or newer), macOS 14.2 (Sonoma) or newer. 8 GB of RAM is fine.
- AI IMAGE and the thumbnail art use ProtoArt Studio's picture engines (ERNIE, FLUX).
  Without ProtoArt Studio installed those buttons explain what's missing; everything
  else (recording, editing, sound, export) works on its own.
- Turn on EXPLAIN (top right) and rest the pointer on anything to see what it does.
- Projects are saved in Movies › ProtoArt Reel. Nothing is uploaded anywhere.

FEEDBACK
Tell me what confused you, what broke, and what you wished it did. Screenshots help a lot,
and for a crash or a stuck recording, mention what you clicked just before.
TXT
rm -f "$DMG"

# The window friends see when they open the DMG: the app on the left, an amber arrow, Applications on the right,
# "Drag ProtoArt Reel onto Applications to install", and the Read Me underneath (like ProtoArt Studio's).
step "Laying out the install window"
BG_OK=0
mkdir -p "$STAGE/.background"
BGPY=""
for py in "$ROOT/../backend/.venv/bin/python" python3; do
  if "$py" -c "import PIL" >/dev/null 2>&1; then BGPY="$py"; break; fi
done
if [ -n "$BGPY" ] && "$BGPY" "$ROOT/tools/dmg_background.py" "$STAGE/.background" >/dev/null 2>&1; then :;
else cp "$ROOT/tools/dmg/bg.png" "$ROOT/tools/dmg/bg@2x.png" "$STAGE/.background/" 2>/dev/null || true; fi
if [ -f "$STAGE/.background/bg.png" ] && tiffutil -cathidpicheck "$STAGE/.background/bg.png" "$STAGE/.background/bg@2x.png" -out "$STAGE/.background/bg.tiff" >/dev/null 2>&1; then
  rm -f "$STAGE/.background/bg.png" "$STAGE/.background/bg@2x.png"; BG_OK=1
fi
for v in "/Volumes/$APP_NAME" "/Volumes/$APP_NAME "*; do [ -d "$v" ] && hdiutil detach "$v" -force >/dev/null 2>&1 || true; done
WORK="$(mktemp -d)"
RW_MB=$(( $(du -sAm "$STAGE" | cut -f1) * 3 / 2 + 200 ))
hdiutil create -volname "$APP_NAME" -size "${RW_MB}m" -fs HFS+ -type SPARSE -ov "$WORK/rw" >/dev/null || fail "hdiutil couldn't create the disk image"
RW="$WORK/rw.sparseimage"
MOUNT="$(hdiutil attach -readwrite -noverify -noautoopen "$RW" | awk -F'\t' '/\/Volumes\// {print $NF}' | tail -1)"
[ -n "$MOUNT" ] && [ -d "$MOUNT" ] || fail "couldn't open the new disk image"
ditto "$STAGE/" "$MOUNT/" || fail "couldn't copy the app into the disk image"
rm -rf "$(dirname "$STAGE")"
DISK="$(basename "$MOUNT")"
BGLINE=""
[ "$BG_OK" = 1 ] && BGLINE='set background picture of opts to file ".background:bg.tiff"'
# (the first time, macOS asks whether Terminal may control Finder: allow it, so the window gets laid out)
if osascript <<OSA >/dev/null 2>&1
tell application "Finder"
  tell disk "$DISK"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set bounds of container window to {200, 120, 860, 608}
    set opts to the icon view options of container window
    set arrangement of opts to not arranged
    set icon size of opts to 96
    set text size of opts to 13
    $BGLINE
    set position of item "$APP_NAME.app" of container window to {170, 170}
    set position of item "Applications" of container window to {490, 170}
    set position of item "Read Me First.txt" of container window to {330, 350}
    update without registering applications
    delay 1
    close
  end tell
end tell
OSA
then echo "Install window ready: app → arrow → Applications."
else echo "Note: couldn't lay out the window (allow Terminal to control Finder in System Settings › Privacy & Security › Automation, then run this again). The DMG still works."; fi
[ -d "$MOUNT/.fseventsd" ] && rm -rf "$MOUNT/.fseventsd" || true
sync
hdiutil detach "$MOUNT" >/dev/null 2>&1 || hdiutil detach "$MOUNT" -force >/dev/null 2>&1 || true
echo "Compressing (a minute or two)…"
hdiutil convert "$RW" -format ULFO -o "$DMG" >/dev/null 2>&1 ||
  hdiutil convert "$RW" -format UDZO -imagekey zlib-level=9 -o "$DMG" >/dev/null ||
  fail "hdiutil couldn't compress the DMG"
rm -rf "$WORK"
hdiutil verify "$DMG" >/dev/null 2>&1 && echo "DMG checked OK."
(cd "$ROOT/dist" && shasum -a 256 "$(basename "$DMG")" > "$(basename "$DMG").sha256")
echo "SHA-256: $(cut -d' ' -f1 "$DMG.sha256")"
echo "Size: $(du -h "$DMG" | cut -f1)"
echo
echo "STATUS: DONE"
open -R "$DMG"
