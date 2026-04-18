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
  # Require a real gitnexus-produced artifact.
  #
  # Previous attempt only rejected "^# Impact:\s*waived" (Codex P1 on PR
  # #287): trivially bypassed with "# Impact: pending", leading whitespace,
  # BOM, or any other hand-rolled header.
  #
  # Switched to a POSITIVE fingerprint: the artifact MUST contain BOTH
  # markers that scripts/gitnexus-impact.sh always writes:
  #   1. First non-empty line starts with "# Impact Analysis — "
  #   2. Body contains a "**Source:** GitNexus knowledge graph" line
  # A hand-written stub would have to fake both, at which point they're
  # copying real output — which is the point.
  #
  # MCP-path users (who produce artifacts via mcp__gitnexus__impact) must
  # prepend these two lines verbatim; trivial one-time cost, documented in
  # the missing-artifact error path below.
  FIRST_NONEMPTY="$(grep -m1 -E '[^[:space:]]' "$IMPACT_FILE" 2>/dev/null || echo "")"
  HAS_HEADER=0
  HAS_SOURCE=0
  HAS_PAYLOAD=0
  if echo "$FIRST_NONEMPTY" | grep -qE '^# Impact Analysis — '; then
    HAS_HEADER=1
  fi
  if head -c 16384 "$IMPACT_FILE" | grep -qE '^\*\*Source:\*\* GitNexus knowledge graph'; then
    HAS_SOURCE=1
  fi
  # Payload check — two accepted shapes, both tied to actual graph state:
  #
  #   (a) Fenced ```json block containing BOTH "incoming" and "outgoing"
  #       keys. Emitted by scripts/gitnexus-impact.sh for files that
  #       HAVE indexed Function/Method/Class symbols (one block per
  #       symbol). Forging this requires producing JSON that matches
  #       the graph's output — effectively the same work as running
  #       the script.
  #
  #   (b) Literal phrase "(no indexed symbols for this file" — emitted
  #       by the script (lines 112-117) for files with no indexed
  #       symbols (const/type-only modules, pure data, genuinely new
  #       files). Codex P1 #4 on PR #287 showed this phrase is
  #       forgeable in isolation because it's static text.
  #
  #       We CLOSE that forgery by verifying the phrase against the
  #       live graph: if the artifact claims "no symbols" but a cypher
  #       count on the file's Function/Method/Class nodes returns > 0,
  #       the claim is a forgery and the artifact is rejected.
  #
  #       Fails closed: if gitnexus binary or graph is unavailable,
  #       the verification can't run, HAS_PAYLOAD stays 0, and the
  #       agent must take the "ask user" escape — same policy as the
  #       rest of the hook. The script itself couldn't have produced
  #       output either, so rejecting stale/can't-verify artifacts
  #       is correct.
  BODY_SCAN="$(head -c 65536 "$IMPACT_FILE")"
  PHRASE_PRESENT=0
  JSON_VALID=0
  if echo "$BODY_SCAN" | grep -qF '(no indexed symbols for this file'; then
    PHRASE_PRESENT=1
  fi
  if echo "$BODY_SCAN" | grep -qE '^```json$' \
      && echo "$BODY_SCAN" | grep -qF '"incoming"' \
      && echo "$BODY_SCAN" | grep -qF '"outgoing"'; then
    JSON_VALID=1
  fi

  if [ $JSON_VALID -eq 1 ]; then
    HAS_PAYLOAD=1
  elif [ $PHRASE_PRESENT -eq 1 ]; then
    # Verify the "no symbols" claim against the live graph.
    BIN_SCRIPT="$REPO_ROOT/scripts/gitnexus-bin.sh"
    if [ -x "$BIN_SCRIPT" ] && [ -e "$REPO_ROOT/.gitnexus/lbug" ] \
        && command -v jq >/dev/null 2>&1; then
      CYPHER_PATH="${REL_PATH//\"/\\\"}"
      CYPHER_JSON="$("$BIN_SCRIPT" cypher \
        "MATCH (s) WHERE (s:Function OR s:Method OR s:Class) AND s.filePath = \"$CYPHER_PATH\" RETURN count(s) AS n" \
        2>/dev/null || echo '')"
      SYMBOL_COUNT="$(echo "$CYPHER_JSON" \
        | jq -r '.markdown // ""' 2>/dev/null \
        | awk -F '|' 'NR>2 {gsub(/^ +| +$/, "", $2); print $2; exit}' \
        2>/dev/null \
        || echo "")"
      # Accept only if the graph confirms zero indexed symbols for
      # this file. Empty string, non-numeric, or >0 → claim unverified
      # or forged → reject (HAS_PAYLOAD stays 0).
      if [ "$SYMBOL_COUNT" = "0" ]; then
        HAS_PAYLOAD=1
      fi
    fi
  fi

  if [ $HAS_HEADER -eq 0 ] || [ $HAS_SOURCE -eq 0 ] || [ $HAS_PAYLOAD -eq 0 ]; then
    cat >&2 <<EOF
╔════════════════════════════════════════════════════════════════╗
║  BLOCKED — Artifact is not a real gitnexus output             ║
╚════════════════════════════════════════════════════════════════╝

File: $REL_PATH
Artifact: $IMPACT_FILE

The artifact does not match the fingerprint of a real gitnexus-
produced analysis. ALL THREE must be present, verbatim:

  1. First non-empty line:   # Impact Analysis — <rel-path>
  2. Somewhere in the body:  **Source:** GitNexus knowledge graph (\`.gitnexus/lbug\`)
  3. A caller/callee payload — ONE of:
        • A fenced \`\`\`json ... \`\`\` block containing BOTH
          "incoming" and "outgoing" JSON keys (emitted when the
          file has indexed symbols).
        • The literal phrase "(no indexed symbols for this file"
          AND the live graph confirms zero Function/Method/Class
          symbols for this file via a cypher count. If gitnexus
          is unavailable or the count is >0, the phrase is treated
          as unverified/forged and rejected.

What your artifact shows:
  Header marker present:   $( [ $HAS_HEADER -eq 1 ] && echo yes || echo NO )
  Source marker present:   $( [ $HAS_SOURCE -eq 1 ] && echo yes || echo NO )
  Payload section present: $( [ $HAS_PAYLOAD -eq 1 ] && echo yes || echo NO )

Hand-written stubs — including "# Impact: waived", "# Impact: pending",
2-line header+source forgeries, empty files, or any other ad-hoc
content lacking a caller/callee payload — are rejected because they
provide zero d=1 blast-radius data. This was the loophole that
wasted session 01RUySybLLDdv36aXXFbuRsr.

Generate a real artifact with one of:

  ./scripts/gitnexus-impact.sh "$REL_PATH"

  # or via the MCP server (you must write the full real format,
  # including the payload section, not just the two header lines):
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
