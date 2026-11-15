#!/bin/bash
# Double-click to install Rust (rustup, cargo and the Rust version native/reel-core pins) into your own user
# folder: ~/.rustup and ~/.cargo, about 1 GB, no administrator password. It doesn't change your shell settings;
# Reel's build finds it in ~/.cargo/bin. The installer comes from Rust's own server (static.rust-lang.org) over
# HTTPS and is checked against the SHA-256 published next to it before it runs.
# To remove Rust later: ~/.cargo/bin/rustup self uninstall
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
exec > >(tee "$ROOT/rust-log.txt") 2>&1
fail() { printf '\nSTATUS: FAILED (%s)\n' "$*"; read -r -p "Press Return to close this window." _; exit 1; }

WANT="$(sed -n 's/^channel *= *"\(.*\)"/\1/p' native/reel-core/rust-toolchain.toml)"
RUSTUP="$HOME/.cargo/bin/rustup"
if [ ! -x "$RUSTUP" ]; then
  case "$(uname -m)" in arm64) TRIPLE=aarch64-apple-darwin ;; x86_64) TRIPLE=x86_64-apple-darwin ;; *) fail "unknown Mac type $(uname -m)" ;; esac
  TMP="$(mktemp -d)" || fail "no temporary folder"
  URL="https://static.rust-lang.org/rustup/dist/$TRIPLE/rustup-init"
  echo "== Downloading the Rust installer for $TRIPLE"
  curl --proto '=https' --tlsv1.2 -fsS "$URL" -o "$TMP/rustup-init" || fail "couldn't download $URL"
  curl --proto '=https' --tlsv1.2 -fsS "$URL.sha256" -o "$TMP/rustup-init.sha256" || fail "couldn't download its checksum"
  EXPECT="$(awk '{print $1}' "$TMP/rustup-init.sha256")"
  GOT="$(shasum -a 256 "$TMP/rustup-init" | awk '{print $1}')"
  [ -n "$EXPECT" ] && [ "$EXPECT" = "$GOT" ] || fail "the installer's checksum didn't match"
  echo "Checksum OK ($GOT)."
  chmod +x "$TMP/rustup-init"
  "$TMP/rustup-init" -y --no-modify-path --profile minimal --default-toolchain "$WANT" || fail "the Rust installer failed"
  rm -f "$TMP/rustup-init" "$TMP/rustup-init.sha256"; rmdir "$TMP" 2>/dev/null
else
  echo "== rustup is already installed; making sure Rust $WANT is there"
  "$RUSTUP" toolchain install "$WANT" --profile minimal || fail "couldn't install Rust $WANT"
fi
echo
echo "== Checking it builds Reel's Rust core"
cd "$ROOT/native/reel-core" && "$HOME/.cargo/bin/cargo" test --release --offline -q || fail "reel-core's own tests failed"
echo
"$HOME/.cargo/bin/rustc" --version
echo "Rust is ready. Now double-click Build ProtoArt Reel.command (or Make DMG for friends)."
echo "STATUS: DONE"
read -r -t 20 -p "Press Return to close this window." _
