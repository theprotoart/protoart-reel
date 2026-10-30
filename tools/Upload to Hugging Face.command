#!/bin/bash
# Double-click after "Make DMG for friends" to put the newest DMG (and its .sha256) on Hugging Face,
# at huggingface.co/brushpenbob/protoart-reel. Uses your saved Hugging Face login; the first time it
# asks you to log in with a token (huggingface.co › Settings › Access Tokens, one with "write" access).
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
REPO="brushpenbob/protoart-reel"
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"
DMG="$ROOT/dist/ProtoArt-Reel-${VERSION}.dmg"
fail() { printf '\nSTATUS: FAILED (%s)\n' "$*"; read -r -p "Press Return to close this window." _; exit 1; }

[ -f "$DMG" ] || fail "no $(basename "$DMG") yet: double-click \"Make DMG for friends\" first"
[ -f "$DMG.sha256" ] || (cd "$ROOT/dist" && shasum -a 256 "$(basename "$DMG")" > "$(basename "$DMG").sha256")

# the Hugging Face command line tool: hf (new) or huggingface-cli (older), from any Python on this Mac
HF=""
for c in hf huggingface-cli "$HOME/miniconda3/bin/hf" "$HOME/miniconda3/bin/huggingface-cli"; do command -v "$c" >/dev/null 2>&1 && { HF="$c"; break; }; done
if [ -z "$HF" ]; then
  echo "Installing the Hugging Face command line tool (once)…"
  PY="$(command -v python3 || echo "$HOME/miniconda3/bin/python3")"
  "$PY" -m pip install --user --quiet -U "huggingface_hub[cli]" || fail "couldn't install huggingface_hub"
  for c in hf huggingface-cli "$("$PY" -m site --user-base)/bin/hf"; do command -v "$c" >/dev/null 2>&1 && { HF="$c"; break; }; done
  [ -n "$HF" ] || fail "huggingface_hub installed, but its hf command isn't on the PATH"
fi

"$HF" auth whoami >/dev/null 2>&1 || "$HF" whoami >/dev/null 2>&1 || { echo "Log in to Hugging Face (paste a write token):"; "$HF" auth login 2>/dev/null || "$HF" login || fail "not logged in"; }

echo "Uploading $(basename "$DMG") to huggingface.co/$REPO …"
"$HF" upload "$REPO" "$DMG" "$(basename "$DMG")" --commit-message "ProtoArt Reel $VERSION" || fail "the DMG upload didn't finish"
"$HF" upload "$REPO" "$DMG.sha256" "$(basename "$DMG").sha256" --commit-message "ProtoArt Reel $VERSION checksum" || fail "the checksum upload didn't finish"
printf '\nSTATUS: DONE. https://huggingface.co/%s/tree/main\n' "$REPO"
read -r -p "Press Return to close this window." _
