# ADR 0004: Bump `modules/interview` Budget — Feedback Page Round 2

**Status:** Active
**Date:** 2026-05-16

## Context

`modules/interview` was last bumped to 32,000 LOC / 160 files in ADR 0003 (replay-upload race fix). That ADR explicitly recommended a structural split — specifically moving `services/analysis/` to its own module — for the next budget pressure event.

This PR (`feat/feedback-round2-phase-a`) does NOT touch `services/analysis/`. The growth is entirely in `components/feedback/` and `components/replay/` (the post-interview feedback page), driven by 6 user-flagged improvements observed on the live preview after the Round 1 IA redesign (PR #365):

- L&D promoted to its own 4th tab with traceable drills + ideal-answer comparison cards (joins original Q + verbatim user answer + dimension scorecard + strong-answer outline).
- Multimodal Key Moments uncapped, un-truncated, click-to-expand with per-question signals + transcript excerpt.
- Coaching tips enriched with category badges + Q-chips + drill cross-links.
- Q-references made navigable everywhere via a new chip component system.

After the commit, the module hit:
- **LOC:** 32,337 (337 over the 32k budget)
- **Files:** 164 of 160 (4 over — the 4 new source files: `LearningTab`, `IdealAnswerComparisonCard`, `QuestionRefChip`, `TextWithQuestionChips`; plus 2 utils `parseQuestionRefs` and `categorizeTip` that pushed pre-PR 158 → 164. Tests don't count per the script's `__tests__` exclusion.)

## Decision

Raise `modules/interview`'s budget to:
- **LOC:** 32,000 → **33,000** (+1,000 LOC, ~3%; absorbs the 337 overage with ~660 LOC headroom)
- **Files:** 160 → **168** (+8 files, ~5%; absorbs the 4 overage with 4-file headroom)

## Rationale

- **Growth is real and load-bearing.** The 6 new source files implement 6 distinct user-flagged improvements. Inlining them would either (a) lose reusability — `QuestionRefChip` + `TextWithQuestionChips` are used across 5 surfaces (top improvements, red flags, coaching tips, drill descriptions, moment cards); `parseQuestionRefs` is used in 4 surfaces — or (b) couple unrelated concerns into single oversized files (e.g. inlining `categorizeTip` into `CoachingPanel`).
- **Step size matches the script's own guidance.** `scripts/check-module-size.mjs:10-13` explicitly states budgets are "early-warning tripwires, not hard limits" and that growth past budget should bump + ADR. The bump here is smaller than the previous 30→32k step (3% vs 7%).
- **Why not the structural split ADR 0003 recommended?** ADR 0003 specifically named `services/analysis/` as the split candidate. This PR's growth is in `components/feedback/` — a different sub-tree. Splitting `components/feedback/` into its own module (or moving to `shared/feedback/`) is plausible but is itself a multi-PR refactor with cascading import changes; it shouldn't be coupled to a feature PR. The `services/analysis/` split remains the recommended next move when *analysis* growth pressures the budget.
- **The new components are well-scoped.** Each is single-purpose and small: `QuestionRefChip` is ~60 LOC, `TextWithQuestionChips` is ~50 LOC, `parseQuestionRefs` is ~75 LOC including doc + types, `categorizeTip` is ~60 LOC. They're not "drift" — they're focused primitives.

## Consequences

- CI's module-size step now passes with Phase A in place.
- Budget headroom is modest: ~660 LOC and 4 files. **Phase B** (the planned hot-path PR adding structured `category` and `targetQuestions` schema fields) will add minimal source LOC (schema field additions + small prompt-text bumps) so should fit.
- **The structural-split recommendation from ADR 0003 still stands.** Specifically:
  - If the next bump is driven by *analysis* growth → split `modules/interview/services/analysis/` into its own `modules/analysis/` module (per ADR 0003).
  - If the next bump is driven by *feedback-page* growth → consider extracting `modules/interview/components/feedback/` into its own `modules/feedback/` module, OR moving the increasingly-shared chip primitives (`QuestionRefChip`, `TextWithQuestionChips`, `parseQuestionRefs`) to `shared/ui/` since they're domain-agnostic.
- File-count budget bump (+8) is generous on purpose to allow Phase B's 1-2 schema-related additions and a few more focused presentational primitives without immediately re-bumping.
