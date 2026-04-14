#!/usr/bin/env bash
# PreToolUse hook — blocks Edit/Write/NotebookEdit on hot-path files
# unless an impact analysis has been created in the current session.
#
# To bypass legitimately, run: ./scripts/gitnexus-impact.sh <file>
# That creates .claude/audit/current/impact-<basename>.md which satisfies this hook.

set -euo pipefail

# Hooks receive tool call info as JSON on stdin
INPUT="$(cat)"
TOOL_NAME="$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || echo "")"
FILE_PATH="$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || echo "")"

# Only gate file-modifying tools
case "$TOOL_NAME" in
  Edit|Write|NotebookEdit) ;;
  *) exit 0 ;;
esac

[ -z "$FILE_PATH" ] && exit 0

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
REL_PATH="${FILE_PATH#$REPO_ROOT/}"

HOTPATH_FILE="$REPO_ROOT/.claude/hotpath.txt"
[ ! -f "$HOTPATH_FILE" ] && exit 0

# Check if file is in hot-path list
IS_HOTPATH=0
while IFS= read -r pattern; do
  [ -z "$pattern" ] && continue
  case "$pattern" in \#*) continue ;; esac
  if [ "$REL_PATH" = "$pattern" ]; then
    IS_HOTPATH=1
    break
  fi
done < "$HOTPATH_FILE"

[ $IS_HOTPATH -eq 0 ] && exit 0

# Require impact analysis artifact
AUDIT_DIR="$REPO_ROOT/.claude/audit/current"
IMPACT_FILE="$AUDIT_DIR/impact-$(basename "$REL_PATH").md"

if [ ! -f "$IMPACT_FILE" ]; then
  cat >&2 <<EOF
╔════════════════════════════════════════════════════════════════╗
║  BLOCKED — Hot-path file edit without impact analysis         ║
╚════════════════════════════════════════════════════════════════╝

File: $REL_PATH

This file is listed in .claude/hotpath.txt. Per CLAUDE.md rules:
every hot-path edit requires a documented blast-radius review
BEFORE the change, not after.

Do this now:

  ./scripts/gitnexus-impact.sh $REL_PATH

That will:
  1. Query .gitnexus/csv/relations.csv for all d=1 callers
  2. Write $IMPACT_FILE
  3. Force you to read and acknowledge the blast radius

Then retry your edit.

If you are SURE no callers can be affected (e.g. pure data file, no
imports), create the impact file manually with a justification:

  mkdir -p $AUDIT_DIR
  echo "# Impact: no callers — <reason>" > $IMPACT_FILE

Bypassing this hook silently is not possible — it runs in the
harness, not in the model.
EOF
  exit 2  # Exit code 2 blocks the tool call in Claude Code
fi

# Require the impact file to be reasonably fresh (24h window)
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
BLOCKED — Impact analysis for $REL_PATH is stale (> 24 hours old).
File: $IMPACT_FILE

Regenerate: ./scripts/gitnexus-impact.sh $REL_PATH
EOF
  exit 2
fi

exit 0
