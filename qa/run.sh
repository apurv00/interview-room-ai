#!/usr/bin/env bash
#
# Run the QA agent locally using Claude Code + Playwright MCP server.
#
# Usage:
#   ./qa/run.sh                              # Test https://interviewprep.guru
#   ./qa/run.sh http://localhost:3000         # Test local dev server
#   ./qa/run.sh https://staging.example.com   # Test staging
#
# Prerequisites:
#   - claude (Claude Code CLI) installed and authenticated
#   - npx available (Node.js)
#   - ANTHROPIC_API_KEY set (or Claude Code already authenticated)
#
# Output:
#   /tmp/screenshots/   — screenshots captured during testing
#   /tmp/qa-report.md   — final QA report
#

set -euo pipefail

URL="${1:-https://interviewprep.guru}"
TEST_MOBILE="${2:-true}"
MAX_TURNS="${3:-80}"
MODEL="${4:-claude-sonnet-4-20250514}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Ensure output directories exist
mkdir -p /tmp/screenshots

# Clean previous run
rm -f /tmp/qa-report.md
rm -f /tmp/screenshots/*.png

echo "╔══════════════════════════════════════════╗"
echo "║           QA Agent — Local Run           ║"
echo "╠══════════════════════════════════════════╣"
echo "║  URL:    $URL"
echo "║  Mobile: $TEST_MOBILE"
echo "║  Model:  $MODEL"
echo "║  Turns:  $MAX_TURNS"
echo "╚══════════════════════════════════════════╝"
echo ""

# MCP config for Playwright (headless Chromium)
MCP_CONFIG='{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest", "--headless", "--browser", "chromium"]
    }
  }
}'

# Build the prompt from the qa/ instruction files
PROMPT="$(cat <<EOF
Read the files qa/identity.md and qa/mission.md for your full instructions.

Target URL: $URL
Test mobile viewports: $TEST_MOBILE

IMPORTANT: Save all screenshots to /tmp/screenshots/ and write your final QA report as markdown to /tmp/qa-report.md so they can be uploaded as artifacts.
EOF
)"

# Run Claude Code with Playwright MCP
claude \
  --print \
  --max-turns "$MAX_TURNS" \
  --model "$MODEL" \
  --allowedTools "mcp__playwright__browser_navigate,mcp__playwright__browser_click,mcp__playwright__browser_type,mcp__playwright__browser_take_screenshot,mcp__playwright__browser_snapshot,mcp__playwright__browser_resize,mcp__playwright__browser_navigate_back,mcp__playwright__browser_wait,mcp__playwright__browser_evaluate,mcp__playwright__browser_select_option,mcp__playwright__browser_hover,mcp__playwright__browser_press_key,Read,Write" \
  --mcp-config "$MCP_CONFIG" \
  --prompt "$PROMPT"

echo ""
echo "════════════════════════════════════════════"

if [ -f /tmp/qa-report.md ]; then
  echo "✓ Report saved to /tmp/qa-report.md"
else
  echo "✗ No report generated"
fi

SCREENSHOT_COUNT=$(find /tmp/screenshots -name '*.png' 2>/dev/null | wc -l)
echo "✓ $SCREENSHOT_COUNT screenshot(s) in /tmp/screenshots/"
echo "════════════════════════════════════════════"
