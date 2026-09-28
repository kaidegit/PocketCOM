#!/bin/sh
# install-macos.sh — copy the packaged bundle to /Applications.
#
# Prereq: dist/PocketCOM.app from tools/package-macos.sh. The bundle is only
# ad-hoc signed, so the quarantine attribute (if the dist copy was ever
# downloaded/extracted externally) is stripped after install — without that,
# Gatekeeper would block the first launch.
#
# Usage: tools/install-macos.sh
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
app="$root/dist/PocketCOM.app"
dest="/Applications/PocketCOM.app"

if [ ! -d "$app" ]; then
  echo "error: missing $app — package the app first:" >&2
  echo "  tools/package-macos.sh" >&2
  exit 1
fi

# Replace wholesale: ditto-merging over an old bundle would leave stale files.
rm -rf "$dest"
ditto "$app" "$dest"
xattr -dr com.apple.quarantine "$dest" 2>/dev/null || true

echo "installed: $dest"
