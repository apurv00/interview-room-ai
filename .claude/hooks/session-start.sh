#!/usr/bin/env bash
# SessionStart hook — initializes the audit directory for this session,
# warns about stale GitNexus index, and prints the accountability banner
# so the user can see the enforcement is live.

set -euo pipefail

INPUT="$(cat 2>/dev/null || echo '{}')"
SESSION_ID="$(echo "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null || echo "unknown")"

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
AUDIT_ROOT="$REPO_ROOT/.claude/audit"
CURRENT_DIR="$AUDIT_ROOT/current"

# Rotate prior session (keep last 5 for forensics)
if [ -d "$CURRENT_DIR" ] && [ -n "$(ls -A "$CURRENT_DIR" 2>/dev/null)" ]; then
  TS="$(date -u +%Y%m%dT%H%M%SZ)"
  mv "$CURRENT_DIR" "$AUDIT_ROOT/session-$TS" 2>/dev/null || true
  # Keep only the 5 most recent archived sessions
  ls -1dt "$AUDIT_ROOT"/session-* 2>/dev/null | tail -n +6 | xargs rm -rf 2>/dev/null || true
fi

mkdir -p "$CURRENT_DIR"
echo "$SESSION_ID" > "$CURRENT_DIR/session-id.txt"
date -u +%Y-%m-%dT%H:%M:%SZ > "$CURRENT_DIR/started-at.txt"

# Check GitNexus index freshness
GITNEXUS_META="$REPO_ROOT/.gitnexus/meta.json"
GITNEXUS_CSV="$REPO_ROOT/.gitnexus/csv/relations.csv"
WARN=""

if [ ! -f "$GITNEXUS_CSV" ]; then
  WARN="⚠️  No GitNexus relations.csv — impact analysis hook will refuse edits."
else
  if command -v stat >/dev/null 2>&1; then
    MTIME=$(stat -c %Y "$GITNEXUS_CSV" 2>/dev/null || stat -f %m "$GITNEXUS_CSV" 2>/dev/null || echo 0)
    NOW=$(date +%s)
    AGE_HOURS=$(( (NOW - MTIME) / 3600 ))
    if [ $AGE_HOURS -gt 48 ]; then
      WARN="⚠️  GitNexus index is $AGE_HOURS hours old. Run: npx gitnexus analyze"
    fi
  fi
fi

cat <<EOF

╭────────────────────────────────────────────────────────────────╮
│ 🔒 CLAUDE ACCOUNTABILITY LAYER ACTIVE                          │
│                                                                │
│  • Edits to files in .claude/hotpath.txt require impact        │
│    analysis: ./scripts/gitnexus-impact.sh <file>               │
│                                                                │
│  • Commits must include: Root-cause, Symbols-modified,         │
│    Tests-added|No-tests-needed-because, Verified-by.           │
│                                                                │
│  • Every commit is logged to .claude/audit/log.md              │
│                                                                │
│  • CI rejects Claude-authored PRs missing these fields.        │
│                                                                │
│  Rules: CLAUDE.md "HOT PATH" and "Commit Accountability"       │
╰────────────────────────────────────────────────────────────────╯
EOF

[ -n "$WARN" ] && echo "$WARN"

exit 0
