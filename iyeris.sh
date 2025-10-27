#!/bin/bash
export TMPDIR="$XDG_RUNTIME_DIR/app/$FLATPAK_ID"
export ELECTRON_IS_DEV=0
cd /app/iyeris
exec zypak-wrapper /app/iyeris/node_modules/electron/dist/electron . "$@"
