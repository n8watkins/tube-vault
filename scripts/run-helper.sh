#!/usr/bin/env bash
# TubeVault native-messaging launcher for native macOS / Linux Chrome.
# Chrome execs this with the extension's stdio pipes; we hand them straight to
# the Node helper. Resolve node from the user's login PATH (Chrome launches with
# a minimal environment), falling back to common install locations.
set -e

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
helper="$here/../helper/dist/index.js"

# Prefer a node already on PATH; otherwise probe the usual spots (nvm, homebrew,
# fnm, system) so a GUI-launched Chrome still finds it.
node_bin="$(command -v node || true)"
if [ -z "$node_bin" ]; then
  for cand in \
    "$HOME/.nvm/versions/node/"*/bin/node \
    "$HOME/.local/share/fnm/"*/bin/node \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node; do
    if [ -x "$cand" ]; then node_bin="$cand"; break; fi
  done
fi

exec "$node_bin" "$helper"
