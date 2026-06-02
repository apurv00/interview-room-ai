# ADR 0009: Bump `modules/interview` File Budget — Shared Filler Tokenizer

**Status:** Active
**Date:** 2026-06-02
**PR:** #432 (interview follow-ups, clarification routing, filler metrics)

## Context

PR #432 fixes inaccurate filler-word metrics. The root cause was two
divergent implementations of filler detection:

- `config/speechMetrics.ts` (live/server path) split on whitespace with **no
  punctuation stripping**, so smart-formatted Deepgram tokens like `"uh,"`
  never matched the filler set → undercount.
- `services/analysis/prosodyService.ts` (multimodal path) stripped punctuation
  but counted `"like"` **unconditionally**, inflating natural usage
  ("a marketplace like this") → overcount.

The fix extracts a single source of truth, **`config/fillerMetrics.ts`**
(`computeFillerMetrics`), consumed by both call sites: punctuation
normalization, contextual `"like"` detection (pause-/neighbor-aware), and
word-weighted aggregation. Its tests land at `__tests__/speechMetrics.test.ts`.

The file-count budget counts **non-test source only**: `countFiles()` in
`scripts/check-module-size.mjs` skips `__tests__/`, and the LOC `find` greps it
out. So of the PR's two new files, exactly **one is counted** —
`config/fillerMetrics.ts`; the test file is invisible to the budget. The module
already sat at the 140 cap, so that single new source file takes it to **141 of
140**, tripping the gate. **LOC is unaffected** (~28.0k of 30k) — a count-shape
change (de-duplication into one small module), not size growth.

## Decision

Raise `modules/interview`'s file budget:

- **Files:** 140 → **142** (+2; ~1 headroom over the current 141)
- **LOC:** unchanged (30 000)

## Rationale

- **The new file removes duplication, it doesn't add bloat.** `fillerMetrics.ts`
  exists precisely so the live path and the multimodal path can no longer drift
  apart — the exact divergence that produced the inconsistent filler numbers.
  LOC holding at ~93% of budget confirms this is a shape change, not a regression.
- **Headroom stays deliberately tight.** ADR 0006 reset this module to 140 to
  keep the tripwire close and force carve-outs (services/analysis/, jobs/) rather
  than reflexive re-bumps. A +1-headroom bump honors that: the next file added
  re-trips the budget and forces another conscious decision.
- **The next bump should be structural, not numeric.** Per ADR 0006, the
  standing plan is to carve `services/analysis/` + `jobs/analysisJob.ts` out of
  `modules/interview` rather than keep raising the cap. This ADR does not change
  that plan; it accommodates one de-duplicating util.

## Consequences

- CI's `check-module-size` step passes with PR #432 in place.
- The interview module sits at 141/142 — effectively at the cap, so the next
  net-new file is a forcing function for the ADR 0006 carve-out.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Inline `computeFillerMetrics` back into `speechMetrics.ts` and import from prosody | Re-introduces a cross-cluster import from `services/analysis/` into `config/`; a standalone shared util is the cleaner boundary and the reason both paths can't drift. |
| Fold the filler logic into both files separately (no shared module) | Recreates the exact two-implementation divergence this PR fixes. |
| Carve out `services/analysis/` now to stay under 140 | Correct long-term move (ADR 0006), but out of scope for a metrics bugfix PR; deferred, not abandoned. |
| Bump to a high cap (e.g. 160) | Treats the budget as soft; ADR 0006's tight-tripwire intent for this module argues for +1 headroom, not open-ended room. |
