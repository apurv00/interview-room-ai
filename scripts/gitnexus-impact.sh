#!/usr/bin/env bash
# Create an impact analysis report for a file by querying the GitNexus
# knowledge graph (not grep, not CSV). Pre-edit hook requires this
# artifact to exist before allowing Edit/Write/NotebookEdit on gated files.
#
# Usage:
#   ./scripts/gitnexus-impact.sh <path/to/file>
#
# Output: .claude/audit/current/impact-<sanitized-path>.md
#
# Contract:
#   - If gitnexus CLI is missing → EXIT 2 (hard fail, NO grep fallback).
#     This is intentional: silent fallback is the theatre we're killing.
#   - If the graph is missing or stale → EXIT 2 with instructions.
#   - If there are zero defined symbols for the file, the report still
#     writes, but includes "(no indexed symbols)" so the hook surfaces
#     the fact that the edit is outside the graph's view.

set -uo pipefail

FILE_PATH="${1:-}"
if [ -z "$FILE_PATH" ]; then
  echo "Usage: $0 <file-path-relative-to-repo-root-or-absolute>" >&2
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
REL_PATH="${FILE_PATH#$REPO_ROOT/}"

# ─── Hard pre-checks ───────────────────────────────────────────────────

BIN="$REPO_ROOT/scripts/gitnexus-bin.sh"
if [ ! -x "$BIN" ]; then
  echo "ERROR: $BIN missing — cannot run graph-based impact analysis." >&2
  echo "This script refuses to fall back to grep. Fix the binary resolver first." >&2
  exit 2
fi

if ! "$BIN" --version >/dev/null 2>&1; then
  echo "ERROR: gitnexus CLI not found on this machine." >&2
  echo "Install it and retry:" >&2
  echo "    npm install -g gitnexus   # or   npx gitnexus analyze" >&2
  exit 2
fi

GRAPH_DB="$REPO_ROOT/.gitnexus/lbug"
META="$REPO_ROOT/.gitnexus/meta.json"
if [ ! -e "$GRAPH_DB" ] || [ ! -f "$META" ]; then
  echo "ERROR: GitNexus index missing at .gitnexus/" >&2
  echo "Run: npx gitnexus analyze" >&2
  exit 2
fi

# Graph freshness — 48h window mirrors the session-start warning.
if command -v stat >/dev/null 2>&1; then
  MTIME=$(stat -c %Y "$META" 2>/dev/null || stat -f %m "$META" 2>/dev/null || echo 0)
  NOW=$(date +%s)
  AGE_HOURS=$(( (NOW - MTIME) / 3600 ))
  if [ "$AGE_HOURS" -gt 48 ]; then
    echo "ERROR: GitNexus index is $AGE_HOURS hours old (stale)." >&2
    echo "Run: npx gitnexus analyze" >&2
    exit 2
  fi
fi

# ─── Output path (sanitize slashes + brackets so filesystem is happy) ──

AUDIT_DIR="$REPO_ROOT/.claude/audit/current"
mkdir -p "$AUDIT_DIR"
SAFE_BASENAME="$(echo "$REL_PATH" | tr '/[]' '___')"
OUT="$AUDIT_DIR/impact-$SAFE_BASENAME.md"

# ─── Query the graph ───────────────────────────────────────────────────

# Escape double quotes in file path for Cypher.
CYPHER_PATH="${REL_PATH//\"/\\\"}"

# Fetch symbols defined in this file.
SYMBOLS_JSON="$(
  "$BIN" cypher "MATCH (s:Function) WHERE s.filePath = \"$CYPHER_PATH\" RETURN s.name AS name
                 UNION
                 MATCH (s:Method) WHERE s.filePath = \"$CYPHER_PATH\" RETURN s.name AS name
                 UNION
                 MATCH (s:Class) WHERE s.filePath = \"$CYPHER_PATH\" RETURN s.name AS name" \
    2>/dev/null || echo '{}'
)"

# Parse names out of the cypher markdown table (cypher CLI returns
# { markdown: "| name |\n| --- |\n| foo |\n| bar |", row_count: N }).
SYMBOLS="$(
  echo "$SYMBOLS_JSON" \
    | jq -r '.markdown // ""' \
    | awk -F '|' 'NR>2 {gsub(/^ +| +$/, "", $2); if ($2 != "" && $2 != "name") print $2}' \
    | sort -u
)"

# ─── Write the report ──────────────────────────────────────────────────

{
  echo "# Impact Analysis — $REL_PATH"
  echo ""
  echo "**Generated:** $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "**Branch:** $(git rev-parse --abbrev-ref HEAD)"
  echo "**Commit:** $(git rev-parse --short HEAD)"
  echo "**Source:** GitNexus knowledge graph (\`.gitnexus/lbug\`)"
  echo ""
  echo "---"
  echo ""

  echo "## Symbols defined in this file"
  echo ""
  if [ -z "$SYMBOLS" ]; then
    echo "_(no indexed symbols for this file — the file may be new,"
    echo "outside the graph's scope, or pure data. If this is a source"
    echo "file under \`app/\`, \`modules/\`, or \`shared/\`, run"
    echo "\`npx gitnexus analyze\` before proceeding.)_"
    echo ""
  else
    echo '```'
    echo "$SYMBOLS"
    echo '```'
    echo ""
  fi

  if [ -n "$SYMBOLS" ]; then
    echo "## Per-symbol callers and callees (from the graph)"
    echo ""
    echo "_Each block is \`gitnexus context <symbol> --file $REL_PATH\` —"
    echo "file-scoped so duplicated names (\`GET\`, \`POST\`, \`handler\`)"
    echo "resolve to THIS file's definition, not the first match. \`incoming\`"
    echo "are d=1 callers (WILL BREAK on signature change); \`outgoing\` are"
    echo "d=1 dependencies (may break this file if they change)._"
    echo ""
    while IFS= read -r sym; do
      [ -z "$sym" ] && continue
      echo "### \`$sym\`"
      echo ""
      echo '```json'
      "$BIN" context "$sym" --file "$REL_PATH" 2>&1 | head -120
      echo '```'
      echo ""
    done <<<"$SYMBOLS"
  fi

  echo "## Risk acknowledgement"
  echo ""
  echo "Before proceeding with the edit, the editor must have:"
  echo ""
  echo "- [ ] Read every d=1 caller above"
  echo "- [ ] Confirmed the change is backward-compatible OR all d=1 callers are updated in the same commit"
  echo "- [ ] A test that exercises the new behavior (or a justified No-tests-needed-because)"
  echo ""
  echo "_This file is auto-generated. The hook only requires it to exist"
  echo "and be fresh (<24h); its existence is the acknowledgement._"
} > "$OUT"

echo "Wrote impact analysis: $OUT"
