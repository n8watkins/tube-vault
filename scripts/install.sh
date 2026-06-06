#!/usr/bin/env bash
# TubeVault — native messaging registration for native macOS / Linux Chrome.
#
# (Windows + WSL users: use scripts/install.ps1 from PowerShell instead — there
#  the extension runs in Windows Chrome and registers via the registry.)
#
# Usage:  ./install.sh <your-chrome-extension-id>
#
# Drops a per-user native-messaging manifest pointing at run-helper.sh into the
# NativeMessagingHosts directory of every Chromium-family browser it finds.
# Everything is derived from this script's location — no hardcoded username.
set -euo pipefail

HOST_NAME="com.tube_vault.helper"

ext_id="${1:-}"
if [ -z "$ext_id" ]; then
  echo "Usage: $0 <chrome-extension-id>" >&2
  echo "  Find the ID at chrome://extensions (Developer mode) after Load unpacked." >&2
  exit 1
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/.." && pwd)"
launcher="$here/run-helper.sh"
chmod +x "$launcher" || true

if [ ! -f "$repo_root/helper/dist/index.js" ]; then
  echo "warning: helper/dist/index.js not found — run 'npm run build --prefix helper' first." >&2
fi

# Candidate NativeMessagingHosts dirs per OS / browser. We register into each
# one that already exists (i.e. the browsers actually installed).
case "$(uname -s)" in
  Darwin)
    app="$HOME/Library/Application Support"
    dirs=(
      "$app/Google/Chrome/NativeMessagingHosts"
      "$app/Google/Chrome Beta/NativeMessagingHosts"
      "$app/Google/Chrome Canary/NativeMessagingHosts"
      "$app/Chromium/NativeMessagingHosts"
      "$app/BraveSoftware/Brave-Browser/NativeMessagingHosts"
      "$app/Microsoft Edge/NativeMessagingHosts"
    ) ;;
  *)
    cfg="$HOME/.config"
    dirs=(
      "$cfg/google-chrome/NativeMessagingHosts"
      "$cfg/google-chrome-beta/NativeMessagingHosts"
      "$cfg/chromium/NativeMessagingHosts"
      "$cfg/BraveSoftware/Brave-Browser/NativeMessagingHosts"
      "$cfg/microsoft-edge/NativeMessagingHosts"
    ) ;;
esac

manifest_json() {
  cat <<JSON
{
  "name": "$HOST_NAME",
  "description": "TubeVault local archive helper",
  "path": "$launcher",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$ext_id/"
  ]
}
JSON
}

installed=0
for d in "${dirs[@]}"; do
  parent="$(dirname "$d")"
  # Only register for browsers whose profile dir exists.
  [ -d "$parent" ] || continue
  mkdir -p "$d"
  manifest_json > "$d/$HOST_NAME.json"
  echo "  registered: $d/$HOST_NAME.json"
  installed=$((installed + 1))
done

if [ "$installed" -eq 0 ]; then
  echo "No Chromium-family browser profile found. Open Chrome once, then re-run." >&2
  exit 1
fi

echo ""
echo "TubeVault native host registered for $installed browser(s)."
echo "  Launcher : $launcher"
echo "  Origin   : chrome-extension://$ext_id/"
echo ""
echo "Reload the extension in Chrome and you're good to go."
