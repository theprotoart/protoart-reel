#!/bin/bash
# Double-click to build "ProtoArt Reel.app" next to this file and open it.
#   --no-open   build only (used by "Make DMG for friends.command")
# Electron comes from ./node_modules (npm ci && npx install-electron). As a local
# fallback it can reuse a copy from $REEL_ELECTRON_APP or ../app/node_modules,
# but only if it is exactly the version pinned in package.json.
cd "$(dirname "$0")"
ROOT="$(pwd)"
exec > >(tee "$ROOT/build-log.txt") 2>&1

APP_NAME="ProtoArt Reel"
BUNDLE_ID="local.protoart.reel"
APP="$ROOT/$APP_NAME.app"
RES="$APP/Contents/Resources"
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"
ELECTRON_VERSION="$(sed -n 's/.*"electron": *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"
step() { printf '\n== %s\n' "$*"; }
fail() { printf '\nSTATUS: FAILED (%s)\n' "$*"; [ -t 0 ] && read -r -p "Press Return to close this window." _; exit 1; }
clone() { cp -cR "$1" "$2" 2>/dev/null || cp -R "$1" "$2"; }

step "1/6 Checking"
[ "$(uname -s)" = "Darwin" ] || fail "this builds a Mac app, so it has to run on a Mac"
[ -f "$ROOT/app/main.js" ] || fail "app files missing"
ELECTRON_APP=""
for candidate in "$ROOT/node_modules/electron/dist/Electron.app" "${REEL_ELECTRON_APP:-}" "$ROOT/../protoart-press/node_modules/electron/dist/Electron.app" "$ROOT/../protoart-wake/node_modules/electron/dist/Electron.app" "$ROOT/../app/node_modules/electron/dist/Electron.app"; do
  [ -n "$candidate" ] && [ -d "$candidate" ] && { ELECTRON_APP="$candidate"; break; }
done
[ -n "$ELECTRON_APP" ] || fail "Electron not found. Run: npm ci && npx install-electron"
FOUND_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$ELECTRON_APP/Contents/Info.plist" 2>/dev/null)"
[ "$FOUND_VERSION" = "$ELECTRON_VERSION" ] || fail "Electron $FOUND_VERSION found, but package.json pins $ELECTRON_VERSION"
ELECTRON_DIST="$(dirname "$ELECTRON_APP")"
echo "Electron $FOUND_VERSION from ${ELECTRON_APP/#$HOME/~}"
FUSES=""
for candidate in "$ROOT/node_modules/@electron/fuses/dist/bin.js" "$(dirname "$(dirname "$ELECTRON_DIST")")/@electron/fuses/dist/bin.js"; do
  [ -f "$candidate" ] && { FUSES="$candidate"; break; }
done
[ -n "$FUSES" ] || fail "@electron/fuses not found. Run: npm ci"
command -v node >/dev/null 2>&1 || fail "Node.js is needed to set Electron fuses"

step "2/6 App shell"
osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1 || true
rm -rf "$APP"
clone "$ELECTRON_APP" "$APP" || fail "couldn't copy Electron"
rm -f "$RES/default_app.asar"

step "3/6 App files"
mkdir -p "$RES/app"
cp "$ROOT/app/main.js" "$ROOT/app/preload.js" "$ROOT/app/hud-preload.js" "$ROOT/app/store.js" "$ROOT/app/validate.js" "$ROOT/app/package.json" "$RES/app/"
cp -R "$ROOT/app/engine" "$ROOT/app/renderer" "$ROOT/app/assets" "$ROOT/app/ai" "$RES/app/"
find "$RES/app" -name '__pycache__' -prune -exec rm -rf {} + 2>/dev/null || true

echo "Building the audio helpers (per-app audio, plug-in host, Voice Clean)…"
mkdir -p "$RES/app/bin"
if xcrun --find swiftc >/dev/null 2>&1; then
  xcrun swiftc -O -swift-version 5 -target arm64-apple-macos14.2 \
    -framework CoreAudio -framework AudioToolbox -framework AVFoundation -framework CoreAudioKit -framework AppKit \
    "$ROOT/native/reel-audio.swift" -o "$RES/app/bin/reel-audio" >"$ROOT/audio-helper-log.txt" 2>&1 \
    && codesign --force --sign - "$RES/app/bin/reel-audio" >/dev/null 2>&1 && echo "Audio helper built." \
    || echo "The audio helper didn't build (see audio-helper-log.txt); per-app audio and plug-ins will be off."
  xcrun swiftc -O -swift-version 5 -target arm64-apple-macos14.2 -framework Speech -framework AVFoundation \
    "$ROOT/native/reel-speech.swift" -o "$RES/app/bin/reel-speech" >"$ROOT/speech-helper-log.txt" 2>&1 \
    && codesign --force --sign - "$RES/app/bin/reel-speech" >/dev/null 2>&1 && echo "Speech helper built (auto captions)." \
    || echo "The speech helper didn't build (see speech-helper-log.txt); auto captions will be off."
else
  echo "Swift isn't installed (xcode-select --install); per-app audio and plug-ins will be off."
fi
if xcrun --find clang >/dev/null 2>&1; then
  RN="$ROOT/native/rnnoise"
  xcrun clang -O3 -arch arm64 -mmacosx-version-min=14.2 -I"$RN" -o "$RES/app/bin/reel-voice" "$ROOT/native/reel-voice.c" \
    "$RN/denoise.c" "$RN/rnn.c" "$RN/rnn_data.c" "$RN/pitch.c" "$RN/kiss_fft.c" "$RN/celt_lpc.c" -lm >"$ROOT/voice-helper-log.txt" 2>&1 \
    && codesign --force --sign - "$RES/app/bin/reel-voice" >/dev/null 2>&1 && echo "Voice Clean built." \
    || echo "Voice Clean didn't build (see voice-helper-log.txt); the built-in voice tools will be off."
else
  echo "clang isn't installed (xcode-select --install); the built-in voice tools will be off."
fi

step "4/6 Licenses"
mkdir -p "$RES/Licenses"
cp "$ROOT/LICENSE" "$RES/Licenses/ProtoArt-Reel-LICENSE.txt"
cp "$ROOT/NOTICE" "$RES/Licenses/ProtoArt-Reel-NOTICE.txt"
cp "$ROOT/THIRD_PARTY_NOTICES.md" "$RES/Licenses/THIRD_PARTY_NOTICES.md"
cp "$ELECTRON_DIST/LICENSE" "$RES/Licenses/Electron-LICENSE.txt" || fail "Electron LICENSE missing"
cp "$ELECTRON_DIST/LICENSES.chromium.html" "$RES/Licenses/LICENSES.chromium.html" || fail "Chromium licenses missing"
cp "$ROOT/native/rnnoise/COPYING" "$RES/Licenses/RNNoise-COPYING.txt" || fail "RNNoise license missing"
echo "Copied 6 license files."

step "5/6 Name, icon, file types, permissions"
PL="$APP/Contents/Info.plist"
PB=/usr/libexec/PlistBuddy
plset() { "$PB" -c "Set :$1 $3" "$PL" 2>/dev/null || "$PB" -c "Add :$1 $2 $3" "$PL"; }
pldel() { "$PB" -c "Delete :$1" "$PL" >/dev/null 2>&1 || true; }
plset CFBundleName string "\"$APP_NAME\""
plset CFBundleDisplayName string "\"$APP_NAME\""
plset CFBundleIdentifier string "$BUNDLE_ID"
plset CFBundleShortVersionString string "$VERSION"
plset CFBundleVersion string "$VERSION"
plset CFBundleIconFile string "icon.icns"
plset LSApplicationCategoryType string "public.app-category.video"
plset NSHumanReadableCopyright string "\"Apache-2.0 · ProtoArt Reel contributors\""
# Electron's template asks for allowances this app doesn't use; camera, microphone and
# audio capture stay (with our own wording) because recording needs them.
for key in NSBluetoothAlwaysUsageDescription NSBluetoothPeripheralUsageDescription NSAppTransportSecurity ElectronAsarIntegrity; do
  pldel "$key"
done
plset NSCameraUsageDescription string "\"ProtoArt Reel records your camera when you turn Camera on for a recording.\""
plset NSMicrophoneUsageDescription string "\"ProtoArt Reel records your microphone when you turn Microphone on for a recording.\""
plset NSAudioCaptureUsageDescription string "\"ProtoArt Reel records the sound your Mac plays when you turn Computer audio on for a recording.\""
plset NSSpeechRecognitionUsageDescription string "\"ProtoArt Reel turns speech in your clips into captions and a transcript you can edit by. It runs on this Mac when your language allows.\""
plset NSScreenCaptureUsageDescription string "\"ProtoArt Reel records the screen or window you pick.\""
# .reel projects are folders shown as one document
pldel CFBundleDocumentTypes
pldel UTExportedTypeDeclarations
plutil -replace UTExportedTypeDeclarations -json '[{"UTTypeIdentifier":"local.protoart.reel.project","UTTypeDescription":"ProtoArt Reel project","UTTypeConformsTo":["com.apple.package"],"UTTypeTagSpecification":{"public.filename-extension":["reel"]}}]' "$PL" || fail "couldn't set the project type"
plutil -replace CFBundleDocumentTypes -json '[{"CFBundleTypeName":"ProtoArt Reel project","CFBundleTypeRole":"Editor","LSTypeIsPackage":true,"LSHandlerRank":"Owner","LSItemContentTypes":["local.protoart.reel.project"]}]' "$PL" || fail "couldn't set the document type"
if [ -f "$ROOT/app/build/icon.png" ]; then
  ICONSET="$(mktemp -d)/icon.iconset"
  mkdir -p "$ICONSET"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$ROOT/app/build/icon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
    sips -z $((s * 2)) $((s * 2)) "$ROOT/app/build/icon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns -o "$RES/icon.icns" "$ICONSET" && rm -f "$RES/electron.icns" && echo "Icon set."
fi

step "6/6 Hardening and signing"
# Fuses: no running the engine as plain Node, no NODE_OPTIONS / inspector, no
# extra file:// privileges (the panel is served from app://), encrypted cookies.
node "$FUSES" write --app "$APP" RunAsNode=off EnableNodeOptionsEnvironmentVariable=off \
  EnableNodeCliInspectArguments=off GrantFileProtocolExtraPrivileges=off EnableCookieEncryption=on >/dev/null \
  || fail "couldn't set Electron fuses"
node "$FUSES" read --app "$APP" | grep -E "RunAsNode|NodeOptions|Inspect|FileProtocol|Cookie" | sed 's/^/  /'
xattr -cr "$APP" 2>/dev/null || true
# A stable signing name keeps macOS permissions (screen, microphone, Input Monitoring) across rebuilds.
# Ad hoc signing makes every build look like a new app to macOS. If you've made a certificate called
# "ProtoArt Local Signing" (Keychain Access › Certificate Assistant › Create a Certificate…, type Code
# Signing), it's used; otherwise the build is signed ad hoc as before.
SIGN_ID="-"; SIGN_NAME="ad hoc"
if security find-identity -v -p codesigning 2>/dev/null | grep -q '"ProtoArt Local Signing"'; then
  SIGN_ID="ProtoArt Local Signing"; SIGN_NAME="ProtoArt Local Signing (permissions carry over)"
fi
codesign --force --deep --sign "$SIGN_ID" "$APP" >"$ROOT/codesign-log.txt" 2>&1 || fail "couldn't sign the app (see codesign-log.txt)"
codesign --verify --deep --strict "$APP" >/dev/null 2>&1 || fail "the signature didn't verify"
echo "Signed ($SIGN_NAME) and verified."
[ "$SIGN_ID" = "-" ] && echo "Note: after this rebuild macOS may need Reel removed and re-added under Screen & System Audio Recording."
touch "$APP"
echo
echo "STATUS: DONE"
[ "${1:-}" = "--no-open" ] || open "$APP"
