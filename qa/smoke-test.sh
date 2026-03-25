#!/usr/bin/env bash
#
# Smoke test for the QA agent pipeline.
#
# Validates the entire chain — Claude CLI, Playwright MCP server, browser,
# screenshot capture, report generation — in ~3 API turns instead of 80.
#
# When no URL is provided, spins up a tiny local HTTP server as the test
# target so the test is fully self-contained (no external network needed).
#
# Usage:
#   ./qa/smoke-test.sh                          # Spin up local test server
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
MODEL="claude-sonnet-4-20250514"
MAX_BUDGET="0.25"    # dollars — keeps smoke test cheap
SESSION_TIMEOUT=300  # seconds
SMOKE_PORT=19876
LOCAL_SERVER_PID=""

cleanup() {
  if [ -n "$LOCAL_SERVER_PID" ]; then
    kill "$LOCAL_SERVER_PID" 2>/dev/null || true
    wait "$LOCAL_SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

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

# Install browser deps if needed
npx playwright install chromium >/dev/null 2>&1 || true
npx playwright install-deps chromium >/dev/null 2>&1 || true

echo "  All prerequisites OK"

# ── 2. Determine target URL ─────────────────────────────────────────────────
if [ -n "${1:-}" ]; then
  URL="$1"
elif curl -sf --max-time 3 http://localhost:3000 >/dev/null 2>&1; then
  URL="http://localhost:3000"
  echo "  Detected local dev server at localhost:3000"
else
  # Start a minimal local HTTP server as test target
  echo "  Starting local test server on port $SMOKE_PORT..."
  node -e "
    const http = require('http');
    const server = http.createServer((req, res) => {
      res.writeHead(200, {'Content-Type': 'text/html'});
      res.end(\`<!DOCTYPE html>
<html lang=\"en\">
<head><meta charset=\"utf-8\"><title>QA Smoke Test Page</title></head>
<body>
  <h1>Interview Prep Guru — Smoke Test</h1>
  <p>This is a test page for the QA agent smoke test.</p>
  <nav>
    <a href=\"/about\">About</a> |
    <a href=\"/contact\">Contact</a>
  </nav>
  <form id=\"test-form\">
    <input type=\"text\" name=\"name\" placeholder=\"Your name\" />
    <button type=\"submit\">Submit</button>
  </form>
</body>
</html>\`);
    });
    server.listen($SMOKE_PORT, () => console.log('ready'));
  " &
  LOCAL_SERVER_PID=$!

  # Wait for server to be ready
  for i in $(seq 1 10); do
    if curl -sf --max-time 1 http://localhost:$SMOKE_PORT >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done

  if ! curl -sf --max-time 2 http://localhost:$SMOKE_PORT >/dev/null 2>&1; then
    echo "FAIL: Could not start local test server" >&2
    exit 1
  fi
  URL="http://localhost:$SMOKE_PORT"
  echo "  Local test server running at $URL"
fi

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║         QA Smoke Test                    ║"
echo "╠══════════════════════════════════════════╣"
echo "║  URL:    $URL"
echo "║  Model:  $MODEL"
echo "║  Budget: \$$MAX_BUDGET"
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
      "args": ["@playwright/mcp@latest", "--headless", "--browser", "chromium", "--no-sandbox", "--output-dir", "/tmp/qa-smoke-screenshots"]
    }
  }
}'

PROMPT="$(cat <<EOF
You are a smoke-test runner. Do exactly these steps and nothing else:

1. Navigate to $URL using mcp__playwright__browser_navigate
2. Take a screenshot using mcp__playwright__browser_take_screenshot
3. Use the Write tool to create the file $SMOKE_REPORT with this content:

# Smoke Test Report
- **URL:** $URL
- **Status:** PASSED
- **Timestamp:** $(date -u +"%Y-%m-%dT%H:%M:%SZ")

That is all. Do not navigate anywhere else or do any additional testing.
EOF
)"

ALLOWED_TOOLS="mcp__playwright__browser_navigate,mcp__playwright__browser_take_screenshot,mcp__playwright__browser_snapshot,Write"

echo "Running Claude session (\$$MAX_BUDGET budget, ${SESSION_TIMEOUT}s timeout)..."
echo ""

set +e
timeout "$SESSION_TIMEOUT" claude \
  -p "$PROMPT" \
  --model "$MODEL" \
  --max-budget-usd "$MAX_BUDGET" \
  --allowedTools "$ALLOWED_TOOLS" \
  --mcp-config "$MCP_CONFIG"
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
  cat "$SMOKE_REPORT"
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
