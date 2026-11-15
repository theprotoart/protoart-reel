#!/bin/bash
# Double-click to install Rust (rustup, cargo and the latest stable Rust) into your own user
# folder: ~/.rustup and ~/.cargo, about 1 GB, no administrator password. It doesn't change your shell settings;
# Reel's build finds it in ~/.cargo/bin. The installer comes from Rust's own server (static.rust-lang.org) over
# HTTPS and is checked against the SHA-256 published next to it before it runs.
# To remove Rust later: ~/.cargo/bin/rustup self uninstall
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
exec > >(tee "$ROOT/rust-log.txt") 2>&1
fail() { printf '\nSTATUS: FAILED (%s)\n' "$*"; read -r -p "Press Return to close this window." _; exit 1; }

NEED="$(sed -n 's/^rust-version *= *"\([^"]*\)".*/\1/p' native/reel-core/Cargo.toml)"
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
  "$TMP/rustup-init" -y --no-modify-path --profile minimal --default-toolchain stable || fail "the Rust installer failed"
  rm -f "$TMP/rustup-init" "$TMP/rustup-init.sha256"; rmdir "$TMP" 2>/dev/null
else
  echo "== rustup is already installed"
  # rustup's own downloader can't connect on some Macs (a firewall or VPN); macOS's curl then does the download
  get() { "$RUSTUP" "$@" || RUSTUP_USE_CURL=1 "$RUSTUP" "$@"; }
  if "$HOME/.cargo/bin/rustc" --version >/dev/null 2>&1; then
    echo "Rust: $("$HOME/.cargo/bin/rustc" --version)"
    # an update is nice to have, not needed: reel-core builds with any Rust from $NEED on
    get update stable --no-self-update >/dev/null 2>&1 && echo "(updated to the latest stable)" || echo "(couldn't check for an update; using what's installed)"
  else
    echo "No Rust version is installed yet: getting the latest stable (a few hundred MB)"
    get toolchain install stable --profile minimal || fail "couldn't download Rust (is static.rust-lang.org blocked by a firewall or VPN?)"
    "$RUSTUP" default stable >/dev/null || fail "couldn't make stable the default"
  fi
fi
echo
echo "== Checking it builds Reel's Rust core"
cd "$ROOT/native/reel-core" && "$HOME/.cargo/bin/cargo" test --release --offline -q || fail "reel-core's own tests failed"
echo
"$HOME/.cargo/bin/rustc" --version
echo "Rust is ready. Now double-click Build ProtoArt Reel.command (or Make DMG for friends)."
echo "STATUS: DONE"
read -r -t 20 -p "Press Return to close this window." _
