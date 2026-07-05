# ADR 0015 — Shared module budget bump: per-answer suggestion helper

**Date:** 2026-07-05
**PR:** #496
**Status:** Accepted

## Context

`scripts/check-module-size.mjs` caps `shared/` at 136 counted `.ts/.tsx` files as
a code-sprawl tripwire. The feedback-scoring fix in PR #496 replaces the inline
"always suggest STAR" ternary — which was duplicated verbatim in two sibling
modules, `@feedback` (`QuestionBreakdown`) and `@learn` (`SourceFeedbackDrawer`) —
with a single deterministic helper: `shared/lib/answerSuggestion.ts`. It selects
the coaching tip from the actual weakest dimension and tailors both the copy and
the dimension labels to the interview family (behavioral / coding / system-design /
academics). That is one new counted file, tripping the count to 137 (> 136). Its
paired test `__tests__/answerSuggestion.test.ts` is **not** counted — `countFiles`
skips `__tests__/`.

## Decision

Bump `shared` `maxFiles` 136 → 137 (+1 for `answerSuggestion.ts`, no extra
headroom). LOC is well under budget — this is a count-shape change, not bloat.

## Alternatives considered

- **Keep the logic duplicated in each module** — rejected. That is the exact
  drift the fix removes: the drill drawer and the feedback page were already
  documented as needing identical copy so they "never give the user contradictory
  advice", and they had silently diverged in intent.
- **Put the helper in `@feedback` and import it from `@learn` via the barrel** —
  rejected. It is a pure, dependency-free helper consumed by two sibling modules;
  `shared/` is the sanctioned home for cross-module pure helpers (same rationale
  as ADR 0011 `categoryMaps` — "shared by X and Y so they cannot drift" — and
  ADR 0007 `useOnboardingProfile`). Housing it in one module and importing it
  from the other would add an unnecessary `@learn → @feedback` coupling.

## Consequences

No extra headroom: the next `shared/` file addition should reassess rather than
reflexively re-bump. The per-row eval-depth resolution (academics warm-ups scored
with the behavioral rubric) stays at the `@feedback` call site via
`resolveEvalDepthSlug`, so the shared helper remains pure and module-agnostic.
