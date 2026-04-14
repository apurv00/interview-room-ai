#!/usr/bin/env bash
# PreToolUse hook on Bash — blocks `git commit` if the message is
# missing required accountability fields.
#
# Rationale: Claude has historically claimed fixes without evidence.
# This hook forces a minimum of: Root-cause, Symbols-modified,
# Tests-added|No-tests-needed-because, Verified-by.

set -euo pipefail

INPUT="$(cat)"
TOOL_NAME="$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || echo "")"
COMMAND="$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || echo "")"

[ "$TOOL_NAME" != "Bash" ] && exit 0

# Only care about git commit (not status, log, diff, add, etc.)
if ! echo "$COMMAND" | grep -qE '(^|[^a-zA-Z])git commit([^a-zA-Z]|$)'; then
  exit 0
fi

# Skip amend operations that reuse message
if echo "$COMMAND" | grep -qE '(--amend.*(--no-edit|--reuse-message)|--amend.*-C |--fixup|--squash)'; then
  exit 0
fi

# Skip --allow-empty (CI housekeeping)
if echo "$COMMAND" | grep -qE '\-\-allow-empty\b'; then
  exit 0
fi

# Extract message: prefer HEREDOC, fall back to -m "..."
MSG=""
if echo "$COMMAND" | grep -q "cat <<'EOF'"; then
  MSG=$(echo "$COMMAND" | awk "/cat <<'EOF'/,/^EOF$/" | sed "1d;/^EOF$/d")
elif echo "$COMMAND" | grep -qE '\-m\s+"'; then
  # Crude extraction — works for single-line -m "msg"
  MSG=$(echo "$COMMAND" | sed -nE 's/.*-m[[:space:]]+"([^"]+)".*/\1/p')
fi

if [ -z "$MSG" ]; then
  # Can't parse — don't block, but leave a trail
  echo "[pre-commit-verify] Could not extract commit message, skipping check" >&2
  exit 0
fi

# Collect missing required fields
MISSING=()
echo "$MSG" | grep -qE '^Root-cause:' \
  || MISSING+=('Root-cause: <actual mechanism, not symptom>')

echo "$MSG" | grep -qE '^(Symbols-modified|Symbols-touched):' \
  || MISSING+=('Symbols-modified: <comma-separated symbols or "none — pure data change">')

echo "$MSG" | grep -qE '^(Tests-added|Tests-updated|No-tests-needed-because):' \
  || MISSING+=('Tests-added: <test file> OR No-tests-needed-because: <reason>')

echo "$MSG" | grep -qE '^Verified-by:' \
  || MISSING+=('Verified-by: <unit test / integration test / manual steps>')

# Hot-path files require a test delta unless explicitly waived
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
HOTPATH_FILE="$REPO_ROOT/.claude/hotpath.txt"
if [ -f "$HOTPATH_FILE" ]; then
  STAGED="$(git diff --cached --name-only 2>/dev/null || true)"
  TOUCHED_HOTPATH=""
  while IFS= read -r pattern; do
    [ -z "$pattern" ] && continue
    case "$pattern" in \#*) continue ;; esac
    if echo "$STAGED" | grep -qxF "$pattern"; then
      TOUCHED_HOTPATH="$pattern"
      break
    fi
  done < "$HOTPATH_FILE"

  if [ -n "$TOUCHED_HOTPATH" ]; then
    HAS_TEST_DELTA=0
    if echo "$STAGED" | grep -qE '(__tests__|\.test\.(ts|tsx|js|jsx)|\.spec\.(ts|tsx|js|jsx))'; then
      HAS_TEST_DELTA=1
    fi
    if [ $HAS_TEST_DELTA -eq 0 ] && ! echo "$MSG" | grep -qE '^No-tests-needed-because:'; then
      MISSING+=("Hot-path file staged ($TOUCHED_HOTPATH) but no test file in this commit. Add a test OR justify with 'No-tests-needed-because:'")
    fi
  fi
fi

if [ ${#MISSING[@]} -gt 0 ]; then
  cat >&2 <<EOF
╔════════════════════════════════════════════════════════════════╗
║  BLOCKED — Commit message missing accountability fields       ║
╚════════════════════════════════════════════════════════════════╝

Missing:
EOF
  for item in "${MISSING[@]}"; do
    echo "  • $item" >&2
  done

  cat >&2 <<'EOF'

Example compliant message:
────────────────────────────────────────────────────────────────
fix(jd-parser): cache never populated on LLM failure

Root-cause: parseJobDescription catches any error (including
  OpenAI 5xx) and returns createFallbackParsedJD which produces
  requirements:[]. Callers in documentContextCache.ts:108 and
  interviewService.ts:221 gate cache-write on
  `requirements.length > 0`, so a failed parse is indistinguishable
  from a successful-empty parse. The cache stays empty for the
  entire session, and every subsequent question hits the raw
  `.slice(0, 2500)` fallback in generate-question/route.ts:65.
Symbols-modified: parseJobDescription, createFallbackParsedJD,
  IParsedJobDescription (added `parseStatus` field)
GitNexus-impact: 3 d=1 callers of parseJobDescription checked —
  getOrLoadJDContext, createSession, /api/interview/parse-jd.
  All updated to read parseStatus.
Tests-added: modules/interview/__tests__/jdParserFailure.test.ts
Verified-by: Unit test simulates LLM throw; asserts parseStatus
  === 'failed' and cache sentinel key `jd:failed:<sid>` is set
  with 5-min TTL so subsequent requests don't retry.
────────────────────────────────────────────────────────────────

Rules: CLAUDE.md "Commit Accountability" section.
The hook reads .claude/hotpath.txt — edit that list to change scope.
EOF
  exit 2
fi

exit 0
