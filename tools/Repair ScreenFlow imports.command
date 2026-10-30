#!/bin/bash
# Double-click (with Reel closed) to repair projects imported from ScreenFlow before the sped-up-clip fix.
cd "$(dirname "$0")"
for p in "$HOME/Movies/ProtoArt Reel/"*.reel; do /usr/bin/python3 "$(pwd)/repair_screenflow_speed.py" "$p"; done
read -r -p "Done. Press Return to close." _
