#!/usr/bin/env bash
#
# Smoke test for the QA agent pipeline.
#
# Validates prerequisites and the browser pipeline end-to-end:
#   1. Checks CLI tools (claude, npx, node, Playwright MCP binary)
#   2. Launches Chromium via Playwright, navigates to a page, takes a screenshot
#   3. Generates a smoke-test report
#
# If --full is passed, runs a real (minimal) Claude + MCP session instead.
# The --full mode requires ANTHROPIC_API_KEY or OAuth with mcp_servers scope.
#
# Usage:
#   ./qa/smoke-test.sh                          # Browser pipeline test (no API calls)
#   ./qa/smoke-test.sh http://localhost:3000     # Test against local dev server
#   ./qa/smoke-test.sh --full                    # Full Claude + MCP test (~3 API turns)
#   ./qa/smoke-test.sh --full http://localhost:3000
#
# Exit codes:
#   0 — Smoke test passed
#   1 — Failure
#

set -euo pipefail

# ── Parse args ───────────────────────────────────────────────────────────────
FULL_MODE=false
URL=""
for arg in "$@"; do
  case "$arg" in
    --full) FULL_MODE=true ;;
    *)      URL="$arg" ;;
  esac
done

# ── Constants ────────────────────────────────────────────────────────────────
SMOKE_SCREENSHOTS="/tmp/qa-smoke-screenshots"
SMOKE_REPORT="/tmp/qa-smoke-report.md"
MODEL="claude-sonnet-4-20250514"
MAX_BUDGET="0.25"
SESSION_TIMEOUT=300
SMOKE_PORT=19876
LOCAL_SERVER_PID=""

cleanup() {
  if [ -n "$LOCAL_SERVER_PID" ] && kill -0 "$LOCAL_SERVER_PID" 2>/dev/null; then
    kill "$LOCAL_SERVER_PID" 2>/dev/null || true
    wait "$LOCAL_SERVER_PID" 2>/dev/null || true
  fi
  LOCAL_SERVER_PID=""
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
check_cmd npx
check_cmd node
if [ "$FULL_MODE" = true ]; then
  check_cmd claude
fi

echo "  Verifying Playwright MCP binary..."
if ! timeout 30 npx @playwright/mcp@latest --help &>/dev/null; then
  echo "FAIL: Playwright MCP server package not available" >&2
  exit 1
fi

echo "  Ensuring Playwright + Chromium are available..."
# Install playwright to node_modules if not already present
node -e "require('playwright')" 2>/dev/null || npm install --no-save playwright@1.56.1 >/dev/null 2>&1
npx playwright install chromium >/dev/null 2>&1 || true
npx playwright install-deps chromium >/dev/null 2>&1 || true

echo "  All prerequisites OK"

# ── 2. Determine target URL ─────────────────────────────────────────────────
if [ -z "$URL" ]; then
  if curl -sf --max-time 3 http://localhost:3000 >/dev/null 2>&1; then
    URL="http://localhost:3000"
    echo "  Detected local dev server at localhost:3000"
  else
    echo "  Starting local test server on port $SMOKE_PORT..."
    node -e "
      const http = require('http');
      http.createServer((req, res) => {
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end(\`<!DOCTYPE html>
<html lang=\"en\">
<head><meta charset=\"utf-8\"><title>QA Smoke Test Page</title></head>
<body>
  <h1>Interview Prep Guru — Smoke Test</h1>
  <p>This is a test page for the QA agent smoke test.</p>
  <nav><a href=\"/about\">About</a> | <a href=\"/contact\">Contact</a></nav>
  <form id=\"test-form\">
    <input type=\"text\" name=\"name\" placeholder=\"Your name\" />
    <button type=\"submit\">Submit</button>
  </form>
</body>
</html>\`);
      }).listen($SMOKE_PORT, () => console.log('ready'));
    " &
    LOCAL_SERVER_PID=$!

    for i in $(seq 1 10); do
      if curl -sf --max-time 1 http://localhost:$SMOKE_PORT >/dev/null 2>&1; then break; fi
      sleep 0.5
    done

    if ! curl -sf --max-time 2 http://localhost:$SMOKE_PORT >/dev/null 2>&1; then
      echo "FAIL: Could not start local test server" >&2
      exit 1
    fi
    URL="http://localhost:$SMOKE_PORT"
    echo "  Local test server running at $URL"
  fi
fi

MODE_LABEL="Browser pipeline"
[ "$FULL_MODE" = true ] && MODE_LABEL="Full (Claude + MCP)"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║         QA Smoke Test                    ║"
echo "╠══════════════════════════════════════════╣"
echo "║  URL:   $URL"
echo "║  Mode:  $MODE_LABEL"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── 3. Clean previous outputs ───────────────────────────────────────────────
mkdir -p "$SMOKE_SCREENSHOTS"
rm -f "$SMOKE_SCREENSHOTS"/*.png
rm -f "$SMOKE_REPORT"

# ── 4. Run the test ─────────────────────────────────────────────────────────

if [ "$FULL_MODE" = true ]; then
  # ── 4a. Full mode: Claude CLI + Playwright MCP ──────────────────────────
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

else
  # ── 4b. Browser pipeline mode: Playwright directly via Node.js ──────────
  echo "Launching Chromium and navigating to $URL..."
  echo ""

  # Write the test script to a temp file to avoid shell escaping issues
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  SMOKE_SCRIPT="$SCRIPT_DIR/.smoke-test-runner.mjs"
  cat > "$SMOKE_SCRIPT" <<SCRIPT_EOF
import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

const url = '${URL}';
const screenshotDir = '${SMOKE_SCREENSHOTS}';
const reportPath = '${SMOKE_REPORT}';

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox']
});
const page = await browser.newPage();

console.log('  Navigating to ' + url + '...');
const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
const status = response ? response.status() : 'unknown';
console.log('  HTTP status: ' + status);

const title = await page.title();
console.log('  Page title: ' + title);

const screenshotPath = screenshotDir + '/smoke-test.png';
await page.screenshot({ path: screenshotPath, fullPage: true });
console.log('  Screenshot saved: ' + screenshotPath);

const snapshot = await page.accessibility.snapshot();
const elementCount = snapshot && snapshot.children ? snapshot.children.length : 0;
console.log('  Accessibility tree: ' + elementCount + ' top-level elements');

await browser.close();
console.log('  Browser closed');

const report = [
  '# Smoke Test Report',
  '',
  '- **URL:** ' + url,
  '- **HTTP Status:** ' + status,
  '- **Page Title:** ' + title,
  '- **Screenshot:** smoke-test.png',
  '- **Accessibility Elements:** ' + elementCount,
  '- **Status:** PASSED',
  '- **Timestamp:** ' + new Date().toISOString(),
  '',
  '## Validated',
  '- [x] Chromium launches in headless mode',
  '- [x] Page navigation succeeds',
  '- [x] Screenshot capture works',
  '- [x] Accessibility snapshot works',
  '- [x] Report generation works',
].join('\n');
writeFileSync(reportPath, report);
console.log('  Report written: ' + reportPath);
SCRIPT_EOF

  node "$SMOKE_SCRIPT" 2>&1
  SMOKE_NODE_EXIT=$?
  rm -f "$SMOKE_SCRIPT"
  if [ "$SMOKE_NODE_EXIT" -ne 0 ]; then
    echo "FAIL: Playwright browser test failed with exit code $SMOKE_NODE_EXIT" >&2
  fi

fi

# ── 5. Assertions ───────────────────────────────────────────────────────────
# Stop the local server before assertions (prevents cleanup trap interrupting)
cleanup
set +e
echo ""
echo "════════════════════════════════════════════"
echo "Checking outputs..."

PASS=true

if [ -s "$SMOKE_REPORT" ]; then
  echo "  ✓ Report exists: $SMOKE_REPORT"
else
  echo "  ✗ Report missing or empty: $SMOKE_REPORT"
  PASS=false
fi

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
  echo ""
  cat "$SMOKE_REPORT"
  echo ""
  echo "SMOKE TEST PASSED"
  exit 0
else
  echo "SMOKE TEST FAILED"
  exit 1
fi
