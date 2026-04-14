#!/usr/bin/env bash
# PostToolUse hook — appends every successful git commit to a permanent
# audit log so the user has an independent record of Claude's claims.
#
# This runs AFTER the commit, so it can't block anything. It just logs.

set -euo pipefail

INPUT="$(cat)"
TOOL_NAME="$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || echo "")"
COMMAND="$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || echo "")"

[ "$TOOL_NAME" != "Bash" ] && exit 0
if ! echo "$COMMAND" | grep -qE '(^|[^a-zA-Z])git commit([^a-zA-Z]|$)'; then
  exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
LOG="$REPO_ROOT/.claude/audit/log.md"
mkdir -p "$(dirname "$LOG")"

SHA=$(git rev-parse --short HEAD 2>/dev/null) || exit 0
SUBJECT=$(git log -1 --pretty=%s 2>/dev/null)
AUTHOR=$(git log -1 --pretty=%an 2>/dev/null)
DATE=$(git log -1 --pretty=%ad --date=iso 2>/dev/null)
FILES=$(git diff --name-only HEAD~1..HEAD 2>/dev/null | grep -c . || true)
TEST_CHG=$(git diff --name-only HEAD~1..HEAD 2>/dev/null | grep -cE '(__tests__|\.test\.|\.spec\.)' || true)
# Defend against empty values from `|| true` in `set -euo pipefail` shells
FILES=${FILES:-0}
TEST_CHG=${TEST_CHG:-0}

# Extract commit fields for the record
BODY=$(git log -1 --pretty=%B 2>/dev/null)
ROOT_CAUSE=$(echo "$BODY" | grep -E '^Root-cause:' | head -1 | sed 's/^Root-cause:[[:space:]]*//' | cut -c1-200)
VERIFIED_BY=$(echo "$BODY" | grep -E '^Verified-by:' | head -1 | sed 's/^Verified-by:[[:space:]]*//' | cut -c1-200)
TESTS=$(echo "$BODY" | grep -E '^(Tests-added|Tests-updated|No-tests-needed-because):' | head -1 | cut -c1-200)

{
  echo ""
  echo "### $DATE · \`$SHA\` · $AUTHOR"
  echo "- **Subject:** $SUBJECT"
  echo "- **Files:** $FILES changed, $TEST_CHG test file(s)"
  [ -n "$ROOT_CAUSE" ] && echo "- **Root-cause:** $ROOT_CAUSE"
  [ -n "$TESTS" ] && echo "- **$TESTS**"
  [ -n "$VERIFIED_BY" ] && echo "- **Verified-by:** $VERIFIED_BY"
} >> "$LOG"

exit 0
