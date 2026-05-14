# ADR 0003: Bump `modules/interview` LOC Budget 30k → 32k

**Status:** Active
**Date:** 2026-05-14

## Context

`modules/interview` has been the densest domain module since the modular-monolith split (ADR 0001) — it houses the live-interview pipeline, multimodal analysis, persona engine, and the resumable-upload utility. The CI budget defined in `scripts/check-module-size.mjs` was previously 30,000 LOC.

A bulletproof fix for the 2026-05-14 production replay-upload race (commit `8bc62b1` "fix(replay-upload): IDB lease + caps close drain/upload race storm") added ~225 lines of production code to `modules/interview/utils/resumableUpload.ts` — four layers of concurrency control (in-memory Set, IDB lease, retry/age caps, auth-failure guard) plus their inline documentation of the invariants each layer protects.

After the commit, the module's LOC count was 30,252 (252 over budget). The pre-commit headroom was already razor-thin (the branch sat at 30,027 — 27 over — before the race fix landed), so the next legitimate change in this module would have tripped CI regardless of the race fix.

## Decision

Raise `modules/interview`'s LOC budget from **30,000 to 32,000**, giving ~1,750 lines of headroom for legitimate future growth.

## Rationale

- **The race-fix LOC is load-bearing.** The added comments document non-obvious concurrency invariants (read-back CAS, lease refresh semantics, the difference between Layer 1 and Layer 2's failure modes). Removing them to fit under the old budget would lose context that's hard to reconstruct from code alone.
- **Budget growth is documented as legitimate.** `scripts/check-module-size.mjs:11-13` explicitly states budgets are "intentionally generous — they're early-warning tripwires, not hard limits" and that growth past budget should bump the budget plus add an ADR.
- **Step size matches prior bumps.** The original budget was 25,000 LOC, bumped to 30,000 when the multimodal analysis pipeline shipped. A 30k→32k step is smaller than the previous one and reflects a more focused growth — the module is mature.
- **Alternatives were considered.** Trimming the race-fix's inline comments to fit under 30k would save ~30 lines but lose the falsification/incident references that prevent future regressions of the same class. The budget bump is the lower-cost option.

## Consequences

- CI's module-size step now passes with the race fix in place.
- Future PRs to `modules/interview` will need a follow-up bump (or genuine refactor) once the module passes 32k LOC.
- When the next bump is needed, prefer a structural split (e.g., moving `services/analysis/` to its own module) over another budget increase. ADR 0001's "internal sub-module split" guidance still applies.
- No change to file-count budget (160 — `modules/interview` is at 154).
