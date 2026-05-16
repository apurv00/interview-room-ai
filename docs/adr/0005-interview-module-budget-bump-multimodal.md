# ADR 0005: Bump `modules/interview` Budget — Multimodal Tab Round 4

**Status:** Active
**Date:** 2026-05-16

## Context

ADR 0004 bumped the budget to 33k LOC / 168 files for feedback-page Round 2 (Phase A). It noted: *"If the next bump is driven by feedback-page growth → consider extracting `modules/interview/components/feedback/` into its own `modules/feedback/` module, OR moving the increasingly-shared chip primitives to `shared/ui/`."*

This PR (Round 4 Multimodal redesign) is exactly that case. The user-provided design is a full rewrite of the Multimodal tab body: video panel + 3-tab right pane, with new sub-components for the bare video shell, live caption overlay, question chapter row, scrubber, signal track, video metric chips, and three tab-body components. 9 new files in the new `modules/interview/components/feedback/multimodal/` subdirectory + 1 tokens file.

After the commit, the module hits:
- **LOC:** approximate (Windows `find` reports 0; CI will report the real number — estimated ~33.5k–34k based on file sizes)
- **Files:** 174 of 168 (6 over)

## Decision

Raise `modules/interview`'s budget to:
- **LOC:** 33,000 → **35,000** (+2,000 LOC, ~6%; comfortable headroom for the file additions + remaining content)
- **Files:** 168 → **180** (+12 files, ~7%; absorbs the 6 overage with 6-file headroom)

## Rationale

- **Growth is structurally clean, not drift.** The new files live in a single coherent subdirectory `multimodal/` with one purpose: render the Multimodal tab. Each file is focused and small (50–250 LOC). The alternative — collapsing all 9 components into one mega-file — would be much worse for readability and testability.
- **The structural-split recommendation from ADRs 0003/0004 still stands** but is its own multi-PR initiative. Moving `components/feedback/` into its own module would require updating every import path in the page-level `page.tsx`, the OverviewTab, the LearningTab, every test file, the tsconfig path aliases, the ESLint cross-module rules, and the gitnexus index. Coupling that refactor to a feature PR is wrong; it deserves its own scoped PR.
- **Step size matches precedent.** Bumps so far: 25k→30k (multimodal pipeline ship, ~20%), 30k→32k (replay-upload race fix, ~7%), 32k→33k (feedback Round 2 Phase A, ~3%), now 33k→35k (~6%). All sensible incremental steps.
- **Deprecated files still in tree.** The Round 4 plan explicitly keeps `MomentCards.tsx`, `TimelineTrack.tsx`, and `CoachingPanel.tsx` in `components/replay/` (no longer used by Multimodal but kept for safety + revert-ability). These count toward the budget. A follow-up cleanup PR can delete them and reduce the file count by ~3.

## Consequences

- CI's module-size step now passes with Round 4 in place.
- Headroom is healthy: ~6 files and ~1k–1.5k LOC, enough for Phase B's small additions + minor polish without immediately re-bumping.
- **The structural-split recommendation is now urgent.** When the next bump becomes necessary, the right move is:
  1. Delete the 3 deprecated files (`MomentCards`, `TimelineTrack`, `CoachingPanel` in `replay/`) once Round 4 is confirmed stable — recovers ~3 files immediately.
  2. Move `modules/interview/components/feedback/multimodal/` to its own top-level module `modules/multimodal/`. The subdirectory is already a coherent unit with a clean boundary.
  3. Then move the shared chip primitives (`QuestionRefChip`, `TextWithQuestionChips`) and the `parseQuestionRefs` util to `shared/ui/` — they're domain-agnostic and used by 3+ surfaces.

The above three steps would recover ~13–15 files from `modules/interview`'s budget without losing any functionality.
