#!/usr/bin/env bash
# TubeVault native-messaging launcher for native macOS / Linux Chrome.
# Chrome execs this with the extension's stdio pipes; we hand them straight to
# the Node helper. Resolve node from the user's login PATH (Chrome launches with
# a minimal environment), falling back to common install locations.
set -e

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
helper="$here/../helper/dist/index.js"

# Prefer a node already on PATH; otherwise probe the usual spots (nvm, homebrew,
# fnm, system) so a GUI-launched Chrome still finds it. Versioned installs
# (nvm/fnm) are sorted newest-first so we don't pick a stale major (e.g. v10
# before v20 — plain glob order is lexicographic, not by version).
node_bin="$(command -v node || true)"
if [ -z "$node_bin" ]; then
  versioned="$(ls -d "$HOME/.nvm/versions/node/"*/bin/node \
                     "$HOME/.local/share/fnm/"*/bin/node 2>/dev/null | sort -Vr || true)"
  for cand in $versioned /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$cand" ]; then node_bin="$cand"; break; fi
  done
fi

if [ -z "$node_bin" ]; then
  echo "TubeVault: no 'node' executable found. Install Node.js or add it to your login PATH." >&2
  exit 1
fi

exec "$node_bin" "$helper"
