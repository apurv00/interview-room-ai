# ADR 0012: Exclude `flow/templates/` from the Interview Module Size Budget

**Status:** Active
**Date:** 2026-06-17
**PR:** feat/interview-domain-coverage (skill+flow coverage for all 24 domains)

## Context

The taxonomy expansion (Phases 4–6) made 24 interview domains selectable but only
authored skill files + flow templates for 7. This PR brings all 24 to parity, adding a
banded flow template per live `domain×type` cell — **54 new files** in
`modules/interview/flow/templates/` (≈ 6k LOC), on top of the 34 that were already
there.

That tripped the module-size gate:

```
modules/interview
  ❌ Files: 196 / 142
  ❌ LOC:   35952 / 30000
```

The budget counts **non-test `.ts`/`.tsx` source only** — `skills/*.md` (the same
domain content, in Markdown) is already invisible to it because it isn't a `.ts` file.
So the *entire* breach is the flow-template directory: 88 `.ts` files (34 + 54) ≈ 10k
LOC. These files are **declarative content** — arrays of slot/question definitions per
`domain × type × seniority` — not application logic. The flow **engine** that consumes
them (`slotBuilder`, `resolver`, `promptBuilder`, `coveragePressure`, `jdOverlayBuilder`,
`types`) lives *outside* `templates/` and is unaffected.

The budget exists as an early-warning tripwire for **code sprawl**. Flow-template count
grows linearly with the *domain catalog*, not with engine complexity, and it will keep
growing as new roles are added. Treating it as code means re-tripping (and re-bumping)
the gate on every catalog expansion — exactly the recurring-pressure failure ADR 0006
warned against.

## Decision

Exclude `modules/interview/flow/templates/` from both the file count and the LOC count
in `scripts/check-module-size.mjs` (via `EXCLUDED_PATHS` + a `grep -v` in the LOC
`find`), alongside the existing `node_modules/` and `__tests__/` exclusions.

The interview budget stays **unchanged at 30 000 LOC / 142 files**. Post-exclusion the
module measures **~25.2k LOC / 107 files**, so the tripwire still has tight headroom and
continues to govern the interview engine/UI code.

## Rationale

- **Symmetry with skill content.** `skills/*.md` (the Markdown analogue of these
  templates) is already excluded by virtue of its extension. A flow template is `.ts`
  only because it needs types + a static import for `TEMPLATE_REGISTRY`; functionally it
  is the same kind of declarative content. Counting one and not the other is an accident
  of file extension.
- **The tripwire keeps its meaning.** Engine and UI code (the things whose growth the
  budget actually wants to catch) remain fully counted. A new template adds content;
  a new *service* or *component* still trips the gate.
- **Carve-out over re-bump.** Per ADR 0006, recurring budget pressure should be resolved
  structurally, not with serial bumps. The domain catalog is unbounded-by-design; its
  content should not be measured against a code budget.
- **Low risk of hiding bloat.** Templates are bounded, uniform data (8–12 slots × 3
  bands, ~110 lines each); they don't accumulate logic. The `skillFlowCoverage` guard
  separately enforces that the set of templates stays correct and complete.

## Consequences

- Adding domains/depths no longer trips the interview size gate (correct — it's content).
- If genuine *logic* ever moves into `flow/templates/` (it should not), it would be
  invisible to the budget. Mitigation: `index.ts` (the registry assembly) is the only
  non-data file in the dir and is trivial import boilerplate; keep it that way.
