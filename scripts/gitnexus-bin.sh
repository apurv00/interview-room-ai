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

# ── Ensure `node` is resolvable ────────────────────────────────────────
# gitnexus is a Node CLI; every resolution path below (the gitnexus shim,
# `npx`, and the unpacked npx-cache binary) needs `node` on PATH to run.
# This wrapper is invoked by pre-edit-hotpath.sh, which the harness can
# spawn with a stripped PATH that omits version-manager shims (nvm/n/
# volta). When that happens `node` is missing and gitnexus dies with
# "env: node: No such file or directory" — silently failing the hook's
# new-file symbol verification and blocking the creation of ANY new source
# file. Discover node from common version-manager / package-manager
# locations and prepend it so the wrapper works in stripped envs too.
# Purely additive: a no-op when `node` is already on PATH.
if ! command -v node >/dev/null 2>&1; then
  _node_dir=""
  # Version-managed installs first (nvm / n). We rely on plain shell glob
  # expansion (ascending) and keep the LAST executable match to prefer a
  # newer version — deliberately NO `sort -V`: that flag is GNU-only and
  # errors on BSD/macOS `sort`, which would drop every nvm candidate in the
  # exact stripped-PATH+nvm case this block exists to recover. Globbing is
  # portable across BSD, macOS, and Linux. Unmatched globs stay literal and
  # are filtered out by the `-x` test.
  for _cand in \
    "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin \
    "$HOME"/.nvm/versions/node/*/bin \
    /usr/local/n/versions/node/*/bin
  do
    if [ -x "$_cand/node" ]; then _node_dir="$_cand"; fi
  done
  # Fixed-location fallbacks (volta / Homebrew / local) only if no
  # version-managed node was found.
  if [ -z "$_node_dir" ]; then
    for _cand in "$HOME"/.volta/bin /opt/homebrew/bin /usr/local/bin; do
      if [ -x "$_cand/node" ]; then _node_dir="$_cand"; break; fi
    done
  fi
  if [ -n "$_node_dir" ]; then
    PATH="$_node_dir:$PATH"
    export PATH
  fi
fi

if [ -n "${GITNEXUS_BIN:-}" ] && [ -x "$GITNEXUS_BIN" ]; then
  exec "$GITNEXUS_BIN" "$@"
fi

if command -v gitnexus >/dev/null 2>&1 && gitnexus --version >/dev/null 2>&1; then
  exec gitnexus "$@"
fi

if command -v cmd.exe >/dev/null 2>&1; then
  if cmd.exe /d /s /c gitnexus.cmd --version >/dev/null 2>&1; then
    # Build a properly-quoted command line for cmd.exe.
    #
    # Why this is necessary:
    #   `cmd.exe /c command "$@"` from bash relies on a cross-platform
    #   round-trip: bash word-splits "$@" into per-arg tokens; Windows'
    #   C runtime rejoins them into a single command-line string using
    #   its own rules; cmd.exe then re-parses that string per ITS rules
    #   (which differ from the CRT's). For simple args this accidentally
    #   works. For args containing spaces, embedded quotes, or
    #   backslashes (e.g. `cypher "MATCH (s:Function) ..."` or a Windows
    #   path like `C:\Users\me\file.ts`), the round-trip silently
    #   mangles them.
    #
    # Vercel agent suggestion on PR #354 (`cmd.exe /d /c "gitnexus.cmd $*"`)
    # makes things worse: $* drops arg boundaries entirely, and removing
    # /s reintroduces cmd's quote-stripping quirks.
    #
    # Correct fix: do the cmd-side quoting ourselves per the documented
    # MS C-runtime argv parser rules, and pass cmd.exe one pre-quoted
    # string. The CRT rules are:
    #   - 2n backslashes + "    →  n backslashes + close-quote
    #   - 2n+1 backslashes + "  →  n backslashes + literal "
    #   - n backslashes NOT before " →  n literal backslashes
    # So we only double backslashes that appear immediately before a
    # double-quote (or before the closing quote of the arg). awk runs
    # once per arg — negligible overhead for a tool called at most a
    # few times per session.
    _win_quote_arg() {
      # Pass the arg via ENVIRON instead of `-v a=...`. awk's -v form
      # interprets backslash escapes during assignment (`\r` → CR,
      # `\\` → single backslash) which would silently mangle Windows
      # paths like `C:\Users\me`.
      _GN_ARG="$1" awk '
        BEGIN {
          a = ENVIRON["_GN_ARG"]
          out = "\""
          bs = 0
          for (i = 1; i <= length(a); i++) {
            c = substr(a, i, 1)
            if (c == "\\") {
              bs++
            } else if (c == "\"") {
              for (j = 0; j < 2*bs + 1; j++) out = out "\\"
              out = out "\""
              bs = 0
            } else {
              for (j = 0; j < bs; j++) out = out "\\"
              out = out c
              bs = 0
            }
          }
          for (j = 0; j < 2*bs; j++) out = out "\\"
          out = out "\""
          printf "%s", out
        }
      '
    }
    win_cmdline="gitnexus.cmd"
    for arg in "$@"; do
      win_cmdline="$win_cmdline $(_win_quote_arg "$arg")"
    done
    # /s ensures cmd.exe treats the whole string after /c as one literal
    # command — no quote stripping. The single bash-quoted "$win_cmdline"
    # argument keeps the cmdline as one token across the exec boundary.
    exec cmd.exe /d /s /c "$win_cmdline"
  fi
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
