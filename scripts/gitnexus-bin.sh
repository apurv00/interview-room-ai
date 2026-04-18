#!/usr/bin/env bash
# Locate a usable gitnexus binary and exec it.
#
# Resolution order:
#   1. $GITNEXUS_BIN (explicit override)
#   2. `gitnexus` on PATH
#   3. `npx gitnexus` (works on any machine with npm)
#   4. Known npx-cache install paths (last-resort for stripped envs
#      where `npx gitnexus` fails but the binary is already unpacked)
#
# Used by .mcp.json, pre-edit-hotpath.sh, and gitnexus-impact.sh so the
# binary location is resolved in one place.

set -euo pipefail

if [ -n "${GITNEXUS_BIN:-}" ] && [ -x "$GITNEXUS_BIN" ]; then
  exec "$GITNEXUS_BIN" "$@"
fi

if command -v gitnexus >/dev/null 2>&1; then
  exec gitnexus "$@"
fi

if command -v npx >/dev/null 2>&1; then
  if npx --no-install gitnexus --version >/dev/null 2>&1; then
    exec npx --no-install gitnexus "$@"
  fi
fi

for cached in /root/.npm/_npx/*/node_modules/.bin/gitnexus \
              "$HOME"/.npm/_npx/*/node_modules/.bin/gitnexus; do
  if [ -x "$cached" ]; then
    exec "$cached" "$@"
  fi
done

cat >&2 <<EOF
gitnexus-bin.sh: no gitnexus binary found.

Install with one of:
  npm install -g gitnexus
  npx gitnexus analyze          # also unpacks into npx cache

Then retry. To force a specific binary, set:
  export GITNEXUS_BIN=/path/to/gitnexus
EOF
exit 127
