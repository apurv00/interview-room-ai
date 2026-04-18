#!/usr/bin/env bash
# PreToolUse hook — blocks Edit/Write/NotebookEdit on ANY source file
# under app/, modules/, or shared/ unless a symbol-level impact analysis
# artifact exists for it in .claude/audit/current/.
#
# To satisfy the hook: ./scripts/gitnexus-impact.sh <file>
# That queries the GitNexus knowledge graph (not grep) and writes:
#   .claude/audit/current/impact-<sanitized-path>.md
#
# Hot-path files (.claude/hotpath.txt) are additionally subject to the
# freshness window (24h). All gated files block on missing artifact.

set -euo pipefail

INPUT="$(cat)"
TOOL_NAME="$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || echo "")"
FILE_PATH="$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || echo "")"

case "$TOOL_NAME" in
  Edit|Write|NotebookEdit) ;;
  *) exit 0 ;;
esac

[ -z "$FILE_PATH" ] && exit 0

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
REL_PATH="${FILE_PATH#$REPO_ROOT/}"

# ─── Scope: only gate source files in reviewable directories ──────────
#
# We gate .ts/.tsx under app/, modules/, shared/. Other file types
# (markdown, config, tests, generated) are out of scope — the graph
# doesn't cover them and the accountability layer is about symbol
# blast radius, not prose.

case "$REL_PATH" in
  app/*|modules/*|shared/*) ;;
  *) exit 0 ;;
esac

case "$REL_PATH" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

# Test files are allowed — they don't ship and the graph shows them as
# leaves. Gating them would punish TDD.
case "$REL_PATH" in
  *.test.ts|*.test.tsx|*.spec.ts|*.spec.tsx|*/__tests__/*) exit 0 ;;
esac

# ─── Hot-path detection (for the freshness gate) ──────────────────────

HOTPATH_FILE="$REPO_ROOT/.claude/hotpath.txt"
IS_HOTPATH=0
if [ -f "$HOTPATH_FILE" ]; then
  while IFS= read -r pattern; do
    [ -z "$pattern" ] && continue
    case "$pattern" in \#*) continue ;; esac
    if [ "$REL_PATH" = "$pattern" ]; then
      IS_HOTPATH=1
      break
    fi
  done < "$HOTPATH_FILE"
fi

# ─── Require the impact artifact ──────────────────────────────────────

SAFE_BASENAME="$(echo "$REL_PATH" | tr '/[]' '___')"
AUDIT_DIR="$REPO_ROOT/.claude/audit/current"
IMPACT_FILE="$AUDIT_DIR/impact-$SAFE_BASENAME.md"

if [ ! -f "$IMPACT_FILE" ]; then
  SCOPE_LABEL="source file"
  [ $IS_HOTPATH -eq 1 ] && SCOPE_LABEL="HOT-PATH file"
  cat >&2 <<EOF
╔════════════════════════════════════════════════════════════════╗
║  BLOCKED — Edit without symbol-level impact analysis          ║
╚════════════════════════════════════════════════════════════════╝

File: $REL_PATH  ($SCOPE_LABEL)

This hook refuses to let you edit a source file without first
consulting the GitNexus knowledge graph for callers/callees.
Grep cannot see dynamic dispatch, barrel re-exports, or transitive
calls — the graph can.

Run:

  ./scripts/gitnexus-impact.sh "$REL_PATH"

That queries .gitnexus/lbug for every symbol in this file, writes
their d=1 callers and callees to:

  $IMPACT_FILE

Then retry the edit.

If the file is out of scope (e.g. pure data, new file with no
references yet) and you're certain no callers exist, create the
artifact manually with a justification:

  mkdir -p "$AUDIT_DIR"
  cat > "$IMPACT_FILE" <<'MARKER'
# Impact: waived — <concrete reason, e.g. "new file, no importers yet">
MARKER

The hook runs in the harness; the model cannot bypass it.
EOF
  exit 2
fi

# Freshness window — hot-path files must have a fresh artifact (24h).
# Non-hot-path files are allowed to coast on an older artifact but still
# must have one.
if [ $IS_HOTPATH -eq 1 ]; then
  MTIME=0
  if stat -c %Y "$IMPACT_FILE" >/dev/null 2>&1; then
    MTIME=$(stat -c %Y "$IMPACT_FILE")
  else
    MTIME=$(stat -f %m "$IMPACT_FILE" 2>/dev/null || echo 0)
  fi
  NOW=$(date +%s)
  AGE=$((NOW - MTIME))
  if [ $AGE -gt 86400 ]; then
    cat >&2 <<EOF
BLOCKED — Impact analysis for $REL_PATH is stale (>24h).
Artifact: $IMPACT_FILE
Regenerate: ./scripts/gitnexus-impact.sh "$REL_PATH"
EOF
    exit 2
  fi
fi

exit 0
