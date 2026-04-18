#!/usr/bin/env bash
# SessionStart hook — rotates audit directory, verifies GitNexus is
# actually wired up (binary + graph + MCP config), and prints the
# accountability banner.

set -euo pipefail

INPUT="$(cat 2>/dev/null || echo '{}')"
SESSION_ID="$(echo "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null || echo "unknown")"

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
AUDIT_ROOT="$REPO_ROOT/.claude/audit"
CURRENT_DIR="$AUDIT_ROOT/current"

# Rotate prior session (keep last 5).
if [ -d "$CURRENT_DIR" ] && [ -n "$(ls -A "$CURRENT_DIR" 2>/dev/null)" ]; then
  TS="$(date -u +%Y%m%dT%H%M%SZ)"
  mv "$CURRENT_DIR" "$AUDIT_ROOT/session-$TS" 2>/dev/null || true
  ls -1dt "$AUDIT_ROOT"/session-* 2>/dev/null | tail -n +6 | xargs rm -rf 2>/dev/null || true
fi

mkdir -p "$CURRENT_DIR"
echo "$SESSION_ID" > "$CURRENT_DIR/session-id.txt"
date -u +%Y-%m-%dT%H:%M:%SZ > "$CURRENT_DIR/started-at.txt"

WARNS=()

# ─── GitNexus binary availability ──────────────────────────────────────
BIN="$REPO_ROOT/scripts/gitnexus-bin.sh"
if [ ! -x "$BIN" ]; then
  WARNS+=("gitnexus-bin.sh missing or not executable — pre-edit hook will block all edits.")
elif ! "$BIN" --version >/dev/null 2>&1; then
  WARNS+=("gitnexus CLI not resolvable — install with 'npm i -g gitnexus'. Pre-edit hook will block all edits.")
fi

# ─── Graph index freshness ────────────────────────────────────────────
GITNEXUS_META="$REPO_ROOT/.gitnexus/meta.json"
GITNEXUS_DB="$REPO_ROOT/.gitnexus/lbug"
if [ ! -f "$GITNEXUS_META" ] || [ ! -e "$GITNEXUS_DB" ]; then
  WARNS+=("GitNexus index missing — run 'npx gitnexus analyze'. Pre-edit hook will block all edits.")
else
  if command -v stat >/dev/null 2>&1; then
    MTIME=$(stat -c %Y "$GITNEXUS_META" 2>/dev/null || stat -f %m "$GITNEXUS_META" 2>/dev/null || echo 0)
    NOW=$(date +%s)
    AGE_HOURS=$(( (NOW - MTIME) / 3600 ))
    if [ $AGE_HOURS -gt 48 ]; then
      WARNS+=("GitNexus index is $AGE_HOURS hours old — run 'npx gitnexus analyze' to refresh.")
    fi
  fi
fi

# ─── MCP registration ─────────────────────────────────────────────────
# Claude Code auto-loads repo-level .mcp.json. If it's missing or
# doesn't reference gitnexus, the gitnexus_* MCP tools won't exist in
# this session and the assistant will fall back to grep.
MCP_JSON="$REPO_ROOT/.mcp.json"
if [ ! -f "$MCP_JSON" ]; then
  WARNS+=(".mcp.json missing — gitnexus MCP tools will NOT be available this session.")
elif ! jq -e '.mcpServers.gitnexus' "$MCP_JSON" >/dev/null 2>&1; then
  WARNS+=(".mcp.json present but has no 'gitnexus' server entry — MCP tools unavailable.")
fi

cat <<EOF

╭────────────────────────────────────────────────────────────────╮
│ 🔒 CLAUDE ACCOUNTABILITY LAYER ACTIVE                          │
│                                                                │
│  • Every .ts/.tsx edit under app/, modules/, shared/ requires  │
│    graph-based impact analysis:                                │
│       ./scripts/gitnexus-impact.sh <file>                      │
│    (reads .gitnexus/lbug; no grep fallback — hard-fails loud)  │
│                                                                │
│  • Hot-path files (.claude/hotpath.txt) additionally require   │
│    the artifact to be <24h old.                                │
│                                                                │
│  • Commits must include: Root-cause, Symbols-modified,         │
│    Tests-added|No-tests-needed-because, Verified-by.           │
│                                                                │
│  • MANUAL WAIVER STUBS (# Impact: waived ...) ARE BLOCKED      │
│    by the pre-edit hook. No bypass.                            │
│                                                                │
│  Rules: CLAUDE.md — HOT PATH + Commit Accountability           │
╰────────────────────────────────────────────────────────────────╯

────────────────────────────────────────────────────────────────────
🔧 MANDATORY FIRST ACTION — LOAD GITNEXUS MCP TOOLS
────────────────────────────────────────────────────────────────────
The gitnexus_* MCP tools are deferred (not pre-loaded with schemas)
to keep the initial tool list small. Before ANY code exploration or
edit, load their schemas via ToolSearch. Paste this exact call:

  ToolSearch({
    query: "select:mcp__gitnexus__impact,mcp__gitnexus__context,mcp__gitnexus__query,mcp__gitnexus__detect_changes,mcp__gitnexus__list_repos,mcp__gitnexus__cypher",
    max_results: 6
  })

Then, as a smoke test before your first edit, call:

  mcp__gitnexus__list_repos()

If it returns []: the graph index is missing. STOP and run
  npx gitnexus analyze 2>&1 | tee /tmp/gitnexus-analyze.log
If the CLI hangs (>5 min no progress), pkill it, inspect the log to
identify the file it was stuck on, and ASK THE USER for guidance.
Do NOT edit code while the index is absent — the hook will block you
and manual waivers are rejected.

Skipping this step is the failure mode that wasted an entire session
on 2026-04-18 (session 01RUySybLLDdv36aXXFbuRsr). Do not repeat it.
────────────────────────────────────────────────────────────────────
EOF

for w in "${WARNS[@]:-}"; do
  [ -z "$w" ] && continue
  echo "⚠️  $w"
done

exit 0
