# IPG Hire Phase 4 — Decide Together Readiness Checklist

**Scope:** the Phase 4 decision, comparison, share-packet, assessment-PDF, and
close-email work defined in [the Hire build plan](./ipg-hire-build-plan.md#phase-4--decide-together).
This is an internal-release checklist: it requires repository, deployment,
index, and controlled internal checks—not a customer pilot.

Status legend: `[x]` verified locally, `[P]` requires the deployed
Hire-control environment or an internal operator action, `[ ]` incomplete.

## Boundary contract

- [x] Decision aggregation is read-only evidence: human scorecards, external
  verdicts, and AI assessments remain distinct; no composite score or automatic
  pipeline move exists.
- [x] Share packets are Hire-local, hash-only capabilities with immutable
  section-gated snapshots; no B2C session, candidate contact data, raw resume,
  raw AI/media/evidence, rank, audit event, or close note is exposed.
- [x] Public packet routes are fragment-capability only, sessionless,
  no-store/no-referrer/noindex, uniformly fail closed, and rate-limited by
  client identity plus a SHA-256 digest of the validated full capability.
- [x] Assessment PDFs are member-authenticated and generated from the same
  allowlisted decision DTO. Lifecycle cancellation creates a bounded durable
  cleanup record before redacting a private artifact.
- [x] Close-email templates are constrained plain text, safely rendered and
  frozen per recipient inside the close transaction; close notes remain
  internal-only.
- [x] No Phase 4 path imports a B2C User model, an interview-engine/runtime
  model, or reuses the B2C scorecard/share service.

## Local implementation evidence

| Build-plan item | Evidence | Status |
| --- | --- | --- |
| Aggregate view: tally, averages, reviewer spread | `modules/hire-decisions` typed decision aggregate | [x] |
| Presentation-clean compare (2–3) | workspace member route and decision-only UI | [x] |
| Action inbox | deterministic pending/evidence/review signals | [x] |
| Share packet + one external verdict | Hire-local capability, public routes and lifecycle hooks | [x] |
| Candidate assessment PDF | authenticated export/renderer and privacy-safe lifecycle | [x] |
| Editable close rejection email | immutable per-recipient outbox snapshot | [x] |

## Required automated verification

- [x] Focused decision-model, aggregate, packet capability, public-route,
  close-email, lifecycle, comparison/action, and PDF suites pass.
- [x] Tenant isolation proves every Phase 4 record has an immutable
  workspace-leading coordinate and no candidate/B2C cross-lookup.
- [x] Privacy, retention, terminal-stage, job-close, workspace soft-delete,
  and hard-purge tests revoke/redact/delete all Phase 4 records and artifacts.
- [x] Middleware/surface/analytics tests prove `/share-packet` is control-only,
  sessionless, and redacted from telemetry.
- [x] `npx vitest run --reporter=dot` (714 passing files, 9,421 passing
  tests, 18 intentional skips), `npx tsc --noEmit --pretty false`,
  `npm run lint`, `npm run build`,
  `node scripts/check-module-size.mjs`, and `git diff --check` pass.
- [x] `npm run prepare:hire-phase4-indexes` prints the 13-index plan without
  connecting to a database or writing an index.
- [x] Protected-boundary diff is clean for `modules/interview/**`,
  `app/api/interviews/**`, `shared/db/models/**`, and
  `shared/services/ttsCache.ts`.

## Deployment and internal checks

- [P] Deploy the exact merged commit to the Hire-control surface and verify
  authenticated health reports that SHA with healthy configuration, MongoDB,
  and Redis.
- [P] Verify `/api/inngest` reports 12 functions, including
  `hire-assessment-export-dispatch` and `hire-assessment-export-recovery`,
  and Inngest has synced/enabled them; events contain only durable IDs.
- [P] Run `npm run check:hire-phase4-indexes` against the isolated control
  database. The plan contains 13 exact indexes across share packets, external
  verdicts, assessment exports, and cleanup tombstones; use an approved
  `npm run prepare:hire-phase4-indexes -- --apply` only if the check identifies
  missing compatible indexes, then re-run the check. Never use a drop/sync
  operation.
- [P] Perform a controlled internal-only check: three member scorecards plus
  one guest-kit scorecard aggregate correctly; separately submit one external
  verdict and confirm it remains distinct from rubric averages; a member
  downloads and forwards the assessment PDF with no manual edits; a
  revoked/expired packet and a privacy-deleted candidate fail closed.
