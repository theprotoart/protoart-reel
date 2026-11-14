#!/bin/bash
# Double-click to download the Electron version package.json pins (and @electron/fuses) into this project's own
# node_modules, so "Build ProtoArt Reel.command" uses it. npm checks the packages against the registry's
# integrity hashes, and Electron's installer checks its download against Electron's published SHA-256 sums.
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
exec > >(tee "$ROOT/electron-log.txt") 2>&1
fail() { printf '\nSTATUS: FAILED (%s)\n' "$*"; read -r -p "Press Return to close this window." _; exit 1; }

WANT="$(sed -n 's/.*"electron": *"\([^"]*\)".*/\1/p' package.json | head -1)"
FUSES="$(sed -n 's/.*"@electron\/fuses": *"\([^"]*\)".*/\1/p' package.json | head -1)"
echo "== Getting Electron $WANT and @electron/fuses $FUSES (about 100 MB, a minute or two)"
command -v npm >/dev/null 2>&1 || fail "npm is needed (it comes with Node.js)"
npm install --no-save --no-audit --no-fund --ignore-scripts=false "electron@$WANT" "@electron/fuses@$FUSES" || fail "npm could not download them"

APP="$ROOT/node_modules/electron/dist/Electron.app"
[ -d "$APP" ] || { echo "Fetching the Electron app itself…"; node node_modules/electron/install.js || fail "the Electron download failed"; }
GOT="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist" 2>/dev/null)"
[ "$GOT" = "$WANT" ] || fail "got Electron $GOT, expected $WANT"
echo
echo "Electron $GOT is ready in node_modules. Now double-click Build ProtoArt Reel.command (or Make DMG for friends)."
echo "STATUS: DONE"
read -r -t 20 -p "Press Return to close this window." _
