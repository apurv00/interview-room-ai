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

if [ -f "$IMPACT_FILE" ]; then
  # Reject manually-written waiver stubs. A real gitnexus artifact contains
  # either "## d=1" / "## Symbols-modified" sections OR a tool-generated
  # summary header. Files whose body is dominated by "waived" / "waiver"
  # language with no caller data are the loophole we closed.
  if head -c 4096 "$IMPACT_FILE" | grep -qiE '^# Impact:[[:space:]]*waived'; then
    cat >&2 <<EOF
╔════════════════════════════════════════════════════════════════╗
║  BLOCKED — Waiver stub is no longer accepted                  ║
╚════════════════════════════════════════════════════════════════╝

File: $REL_PATH
Artifact: $IMPACT_FILE

The artifact starts with "# Impact: waived" — that's the hand-written
stub the old hook let through. We closed that loophole because it
was used to skip analysis entirely.

Regenerate a real artifact with one of:

  ./scripts/gitnexus-impact.sh "$REL_PATH"

  # or via the MCP server:
  ToolSearch({ query: "select:mcp__gitnexus__impact", max_results: 2 })
  mcp__gitnexus__impact({ target: "<symbol or relative file path>",
                          direction: "upstream" })

If gitnexus truly cannot analyze this file, STOP and ask the user.
Do not edit around this block.
EOF
    exit 2
  fi
fi

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

Run EITHER of these — both write the artifact to:

  $IMPACT_FILE

1. CLI:
     ./scripts/gitnexus-impact.sh "$REL_PATH"

2. MCP (gitnexus tools). These are deferred by default — load first:
     ToolSearch({ query: "select:mcp__gitnexus__impact,mcp__gitnexus__context,mcp__gitnexus__list_repos,mcp__gitnexus__detect_changes", max_results: 5 })
   then:
     mcp__gitnexus__impact({ target: "<symbol or relative file path>", direction: "upstream" })
   and write the returned blast-radius into the artifact file yourself.

If the CLI hangs or the index is missing (.gitnexus/ absent):

  • pkill -f 'gitnexus analyze'    # kill any hung run
  • rm -rf .gitnexus/.lock          # if a stale lock exists
  • npx gitnexus analyze 2>&1 | tee /tmp/gitnexus-analyze.log
    → if it hangs, check the log for the file it was parsing when
      stuck; that file is the probable culprit.

MANUALLY-WRITTEN WAIVERS ARE NO LONGER ACCEPTED. Earlier versions
of this hook documented a fallback where the agent could write an
"# Impact: waived — <reason>" stub file to bypass the check. That
loophole was abused to skip analysis entirely. An artifact must now
contain a real d=1 caller list produced by gitnexus (CLI or MCP).

If gitnexus genuinely cannot analyze this file (e.g. index not yet
built for a first-ever commit and the CLI won't run), the correct
action is to FIX gitnexus, not to bypass. Ask the user before
proceeding any further — do not edit.

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
