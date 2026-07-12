# ADR 0016 — Shared module budget bump: Jobs feature models

**Date:** 2026-07-12
**PR:** jobs Wave 0.3 (feat/jobs-wave03-jd-cleanup) + Wave 1
**Status:** Accepted

## Context

`scripts/check-module-size.mjs` caps `shared/` at 137 counted `.ts/.tsx` files
as a code-sprawl tripwire. The Jobs feature (founder-directed 2026-07-12:
relevant jobs + readiness w.r.t. resume and interview preparedness + apply
link-out, integrated into the existing flow) adds seven counted shared files
across two PRs — all placed by the repo's own conventions, not by sprawl:

- **Four ingestion-corpus models** (Wave 0.3): `JobPosting` (with the
  never-written-in-Phase-A `llmVerdict` sub-schema per DECISIONS ruling #16),
  `JobSourceConfig`, `JobIngestCursor`, `JobIngestCycle`. Models live in
  `shared/db/models/` to prevent cross-module import chains — the ownership-map
  header in the models barrel is explicit that the directory holds every
  module's models while each is owned by its domain module (`modules/jobs`).
- **Two product-flow models** (Wave 1): `JobApplication` (tracker status
  machine + tailoredVersion + atsResult) and `ProductEvent` (signed-anon-cookie
  event capture) — same convention, specced in PRODUCT_FLOW.md §2.
- **One adapter helper**: `shared/fetchJSONWithRetry.ts` — the typed JSON
  fetch the ingestion adapters need; the existing `shared/fetchWithRetry.ts`
  resolves boolean and discards the body. Kernel-appropriate (zero module
  imports), same cross-module-dedup rationale as ADR 0011/0015.

One deletion partially offsets: `SavedJobDescription.ts` (dead surface) was
removed in the same Wave 0.3 PR, and its `IParsedJobDescription` types were
hoisted into the existing `shared/types.ts` (no new file).

## Decision

Raise `shared` `maxFiles` 137 → **145**: 137 + 7 counted additions = 144,
plus 1 headroom (the same +1 convention as ADRs 0013/0015). Net-of-deletion
the steady-state count is ~143. LOC stays well under budget (~15k/25k) —
these are declarative model/schema files, not logic sprawl. Paired tests are
not counted (`countFiles` skips `__tests__/`).

## Consequences

- The tripwire keeps working: the next unplanned shared file still trips the
  gate and forces an ADR.
- If the Jobs feature is ever rolled back (day-60 kill rule), the budget
  should be re-lowered in the same PR that removes the models.
