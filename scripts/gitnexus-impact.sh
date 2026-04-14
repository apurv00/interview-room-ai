#!/usr/bin/env bash
# Create an impact analysis report for a file so Claude's pre-edit hook
# will allow the edit. Usage:
#
#   ./scripts/gitnexus-impact.sh <path/to/file>
#
# Output: .claude/audit/current/impact-<basename>.md

set -uo pipefail
# Note: no `-e` — grep returns 1 when there are no matches, which is fine.

FILE_PATH="${1:-}"
if [ -z "$FILE_PATH" ]; then
  echo "Usage: $0 <file-path-relative-to-repo-root-or-absolute>"
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
REL_PATH="${FILE_PATH#$REPO_ROOT/}"

AUDIT_DIR="$REPO_ROOT/.claude/audit/current"
mkdir -p "$AUDIT_DIR"
OUT="$AUDIT_DIR/impact-$(basename "$REL_PATH").md"

RELATIONS="$REPO_ROOT/.gitnexus/csv/relations.csv"
FUNCTIONS="$REPO_ROOT/.gitnexus/csv/function.csv"
METHODS="$REPO_ROOT/.gitnexus/csv/method.csv"

{
  echo "# Impact Analysis — $REL_PATH"
  echo ""
  echo "**Generated:** $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "**Current branch:** $(git rev-parse --abbrev-ref HEAD)"
  echo "**Current commit:** $(git rev-parse --short HEAD)"
  echo ""
  echo "---"
  echo ""

  if [ ! -f "$RELATIONS" ]; then
    echo "## ⚠ GitNexus index missing"
    echo ""
    echo "\`.gitnexus/csv/relations.csv\` not found. Run:"
    echo ""
    echo "    npx gitnexus analyze"
    echo ""
    echo "Falling back to grep-only analysis."
    echo ""
  fi

  echo "## Symbols defined in this file"
  echo ""
  {
    [ -f "$FUNCTIONS" ] && grep ",\"$REL_PATH\"," "$FUNCTIONS" 2>/dev/null | cut -d',' -f1,2 | head -50
    [ -f "$METHODS" ] && grep ",\"$REL_PATH\"," "$METHODS" 2>/dev/null | cut -d',' -f1,2 | head -50
  } | sort -u || echo "(no symbols indexed)"
  echo ""

  echo "## Downstream — what THIS file calls (its dependencies)"
  echo "_If any of these change, this file may break._"
  echo ""
  if [ -f "$RELATIONS" ]; then
    # Lines where the FROM side starts with a symbol in this file
    grep "$REL_PATH:" "$RELATIONS" 2>/dev/null \
      | grep ',"CALLS",' \
      | awk -F',' -v p="$REL_PATH" '$1 ~ p { print "  " $1 " → " $2 }' \
      | sort -u \
      | head -40
  fi
  echo ""

  echo "## Upstream — things that call INTO this file (d=1 WILL BREAK)"
  echo "_If you change signatures, all of these must be updated._"
  echo ""
  if [ -f "$RELATIONS" ]; then
    grep "$REL_PATH:" "$RELATIONS" 2>/dev/null \
      | grep ',"CALLS",' \
      | awk -F',' -v p="$REL_PATH" '$2 ~ p && $1 !~ p { print "  " $1 " → " $2 }' \
      | sort -u \
      | head -40
  fi
  echo ""

  echo "## Callers — grep cross-check"
  echo ""
  BASE=$(basename "$REL_PATH" .ts)
  BASE="${BASE%.tsx}"
  # Show files that import this module
  grep -rln "from ['\"].*${BASE}['\"]" "$REPO_ROOT/app" "$REPO_ROOT/modules" "$REPO_ROOT/shared" \
    --include="*.ts" --include="*.tsx" 2>/dev/null \
    | head -30 \
    || echo "(no grep imports found)"
  echo ""

  echo "## Risk acknowledgement"
  echo ""
  echo "Before proceeding with the edit, confirm:"
  echo ""
  echo "- [ ] I read every d=1 caller listed above"
  echo "- [ ] I understand which callers' behavior my change affects"
  echo "- [ ] My change is either:"
  echo "      - [ ] Backward-compatible (purely additive, optional params), OR"
  echo "      - [ ] All d=1 callers are updated in the same commit"
  echo "- [ ] I have a test that exercises the new behavior (or justified why not)"
  echo ""
  echo "Edit this file manually to add notes or leave as-is — the hook"
  echo "only requires the file to exist and be fresh (<24h)."
} > "$OUT"

echo "✅ Wrote impact analysis: $OUT"
echo ""
echo "Review it, then proceed with your edit."
