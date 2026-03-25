#!/usr/bin/env bash
#
# Smoke test for the QA agent pipeline.
#
# Validates the entire chain — Claude CLI, Playwright MCP server, browser,
# screenshot capture, report generation — in ~3 API turns instead of 80.
#
# Usage:
#   ./qa/smoke-test.sh                          # Auto-detect URL (localhost:3000 → example.com)
#   ./qa/smoke-test.sh http://localhost:3000     # Test local dev server
#   ./qa/smoke-test.sh https://example.com       # Test a specific URL
#
# Exit codes:
#   0 — Smoke test passed (screenshot + report generated)
#   1 — Failure (missing prerequisite, Claude session failed, or missing outputs)
#

set -euo pipefail

# ── Constants ────────────────────────────────────────────────────────────────
SMOKE_SCREENSHOTS="/tmp/qa-smoke-screenshots"
SMOKE_REPORT="/tmp/qa-smoke-report.md"
MAX_TURNS=3
MODEL="claude-sonnet-4-20250514"
SESSION_TIMEOUT=120  # seconds

# ── 1. Prerequisite checks ──────────────────────────────────────────────────
check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    echo "FAIL: '$1' not found in PATH" >&2
    exit 1
  fi
}

echo "Checking prerequisites..."
check_cmd claude
check_cmd npx
check_cmd node

echo "Verifying Playwright MCP server..."
if ! timeout 30 npx @playwright/mcp@latest --help &>/dev/null; then
  echo "FAIL: Playwright MCP server failed to start" >&2
  exit 1
fi
echo "  All prerequisites OK"

# ── 2. Determine target URL ─────────────────────────────────────────────────
if [ -n "${1:-}" ]; then
  URL="$1"
elif curl -sf --max-time 3 http://localhost:3000 >/dev/null 2>&1; then
  URL="http://localhost:3000"
  echo "  Detected local dev server at localhost:3000"
else
  URL="https://example.com"
  echo "  localhost:3000 not available, using https://example.com"
fi

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║         QA Smoke Test                    ║"
echo "╠══════════════════════════════════════════╣"
echo "║  URL:   $URL"
echo "║  Model: $MODEL"
echo "║  Turns: $MAX_TURNS"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── 3. Clean previous outputs ───────────────────────────────────────────────
mkdir -p "$SMOKE_SCREENSHOTS"
rm -f "$SMOKE_SCREENSHOTS"/*.png
rm -f "$SMOKE_REPORT"

# ── 4. Run minimal Claude session ───────────────────────────────────────────
MCP_CONFIG='{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest", "--headless", "--browser", "chromium"]
    }
  }
}'

PROMPT="$(cat <<EOF
You are a smoke-test runner. Do exactly these steps and nothing else:

1. Navigate to $URL
2. Take a screenshot using browser_take_screenshot
3. Use the Write tool to create the file $SMOKE_REPORT with this content:

# Smoke Test Report
- **URL:** $URL
- **Status:** PASSED
- **Timestamp:** $(date -u +"%Y-%m-%dT%H:%M:%SZ")

That is all. Do not navigate anywhere else or do any additional testing.
EOF
)"

ALLOWED_TOOLS="mcp__playwright__browser_navigate,mcp__playwright__browser_take_screenshot,mcp__playwright__browser_snapshot,Write"

echo "Running Claude session (max $MAX_TURNS turns, ${SESSION_TIMEOUT}s timeout)..."
echo ""

set +e
timeout "$SESSION_TIMEOUT" claude \
  --print \
  --max-turns "$MAX_TURNS" \
  --model "$MODEL" \
  --allowedTools "$ALLOWED_TOOLS" \
  --mcp-config "$MCP_CONFIG" \
  --prompt "$PROMPT"
CLAUDE_EXIT=$?
set -e

if [ "$CLAUDE_EXIT" -ne 0 ]; then
  echo ""
  echo "WARN: Claude session exited with code $CLAUDE_EXIT (may still have generated outputs)"
fi

# ── 5. Assertions ───────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════"
echo "Checking outputs..."

PASS=true

# Check for report
if [ -s "$SMOKE_REPORT" ]; then
  echo "  ✓ Report exists: $SMOKE_REPORT"
else
  echo "  ✗ Report missing or empty: $SMOKE_REPORT"
  PASS=false
fi

# Check for screenshots (Playwright MCP may save to its own path or /tmp/screenshots/)
SCREENSHOT_COUNT=0
for dir in "$SMOKE_SCREENSHOTS" "/tmp/screenshots"; do
  count=$(find "$dir" -name '*.png' 2>/dev/null | wc -l)
  SCREENSHOT_COUNT=$((SCREENSHOT_COUNT + count))
done

if [ "$SCREENSHOT_COUNT" -gt 0 ]; then
  echo "  ✓ Screenshots captured: $SCREENSHOT_COUNT file(s)"
else
  echo "  ✗ No screenshots found"
  PASS=false
fi

echo "════════════════════════════════════════════"

if [ "$PASS" = true ]; then
  echo "SMOKE TEST PASSED"
  exit 0
else
  echo "SMOKE TEST FAILED"
  exit 1
fi
