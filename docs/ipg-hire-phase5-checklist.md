# IPG Hire Phase 5 — Reports, Trust + Polish Readiness Checklist

**Plan of record:** [IPG Hire build plan](./ipg-hire-build-plan.md),
[Reports & exports](./ipg-hire-build-plan.md#reports--exports), and
[Phase 5 — Reports, Trust + Polish](./ipg-hire-build-plan.md#phase-5--reports-trust--polish).

This is an internal-release checklist. It separates source and automated proof
from the deployment and controlled internal checks that cannot be established
locally. A customer pilot is **not** a Phase 5 requirement.

### No-customer-pilot policy

Phase 5 is released through repository gates, the isolated Hire-control
database, and owned internal workspaces only. Customer-pilot enrollment,
customer data, customer email delivery, and external customer sign-off are not
completion criteria and must not be introduced as substitute release evidence.

Status legend: `[x]` verified against the candidate source with named evidence;
`[P]` requires the deployed Hire-control environment or an internal operator;
`[ ]` is an unresolved implementation or release item.

## Release contract

- [x] **Evidence stays distinguishable from decisions.** Reports and operations
      views preserve the separate AI, member-scorecard, kit-scorecard, and external
      verdict evidence established in Phase 4; no report invents a blended score or
      moves a candidate automatically.
- [x] **All internal data is workspace-scoped.** Every member route, reader,
      export, report job, audit entry, and digest uses immutable Hire workspace
      coordinates and exact authorization; no path resolves a Hire candidate through
      a B2C `User`.
- [x] **Exports are least-disclosure.** Internal-only rank never appears in a
      PDF, spreadsheet, CSV, candidate status page, guest link, digest, telemetry,
      or job report. Candidate contact data, raw resumes, raw media/transcripts,
      capabilities, provider errors, and private keys are absent unless an
      authenticated member's explicitly scoped internal view requires them.
- [x] **Trust boundaries remain intact.** Phase 5 adds no write to the interview
      engine or B2C persistence and does not weaken the Phase 1–4 consent, guest
      capability, sessionless-public-route, privacy, retention, or terminal-stage
      fences.

## Local implementation and automated evidence

### Operations and reporting

- [x] **KPI strip.** The workspace surface presents at most the four planned
      measures—open jobs, candidates awaiting a decision, scorecard completion, and
      median time-to-close—from a tenant-scoped, deterministic reader with safe
      empty states.
- [x] **Jobs health view.** One row per authorized job shows days open, a mini
      funnel, and actionable aging/blocker chips; ordering is needs-attention first,
      not alphabetical. Closed/deleted jobs and lifecycle-inactive workspaces do not
      leak into the view.
- [x] **Per-job performance view.** Funnel conversion, score distribution, and
      top-of-pool evidence are scoped to one job. Charts render only at the plan's
      approximately ten-record threshold; smaller cohorts render the people/evidence
      rather than misleading statistics. No cross-job candidate comparison is
      introduced.
- [x] **Pipeline status report.** An authenticated member can produce the
      planned per-job or all-job status report in the supported PDF and/or Excel
      form, including stage counts, aging, and blockers from an allowlisted,
      reproducible snapshot.
- [x] **Job close-out report.** Closing a job produces (or durably requests)
      an internal close-out report with funnel numbers, time-to-close, the hired
      candidate where applicable, and the required decision note; retries and
      duplicate close events cannot create contradictory reports.
- [x] **CSV data export.** An authenticated member can export the planned
      workspace candidates and statuses with correct tenant filters, stable headers,
      spreadsheet-formula neutralization, bounded streaming or durable-generation
      behavior, and no fields excluded by the export policy.

### Candidate, onboarding, and trust surfaces

- [x] **Candidate status page.** A candidate can see only the intended
      no-login, capability-scoped status progression (for example, “round 2 of 3”)
      with a uniform inactive result for invalid, expired, revoked, privacy-redacted,
      terminal, or cross-tenant links. It is no-store/no-referrer/noindex and does
      not disclose decision evidence, rankings, notes, contact data, or other
      candidates.
- [x] **“Interview yourself” onboarding test drive.** A new workspace member
      can reach a first owned AI-interview result through the guided test drive.
      The flow preserves consent/recording disclosure, creates only Hire-owned
      attributable records, is idempotent under retries, and does not turn a test
      session into an accidental real candidate workflow.
- [x] **Audit trail.** Material report/export requests and completions, candidate
      status capability lifecycle, onboarding/test-drive actions, digest deliveries,
      and operational decisions record a bounded, tenant-scoped actor/action/time
      audit receipt. Audit data never contains raw capabilities, raw export content,
      unbounded PII, provider responses, or secrets.
- [x] **Empty and small-n states.** New workspaces begin with the planned one
      job/eight-candidate guidance, reports and operations views explain empty,
      pending, failed, and insufficient-sample states without fabricating metrics,
      and each recovery path is member-authorized.

### Digest, lifecycle, and durability

- [x] **Daily email digest.** A Hire-control scheduled worker sends only
      workspace-member operational summaries through the approved email path, with
      recipient/lifecycle authorization immediately before provider egress,
      idempotent daily delivery, bounded retries, and no capability, candidate
      contact, raw evidence, or report attachment in logs/events. Preference and
      opt-out behavior must match the implemented product contract.
- [x] **Report/export lifecycle.** Requested, running, ready, failed, expired,
      cancelled, and cleanup states are durable and bounded. Private report artifacts
      are not served through public URLs and are deleted through an explicit,
      retry-safe cleanup path.
- [x] **Privacy, retention, and deletion.** Candidate privacy deletion,
      terminal application/job transitions, workspace soft-delete, retention, and
      hard purge revoke status access, cancel report/digest work, redact/delete
      snapshots and artifacts, and prevent later provider egress. A race must have
      an explicit linearization point rather than a best-effort outcome.
- [x] **Tenant/capability regression coverage.** Focused tests prove
      cross-workspace reads/writes fail, public status links are possession-only,
      invalid links are indistinguishable, and analytics/referrers/logs do not carry
      raw capability material or export contents.

### Required local gates

- [x] Focused model, validator, service, route, UI, report-rendering,
      CSV-spreadsheet-safety, status-capability, onboarding, audit, digest,
      lifecycle/privacy, and index-script suites pass on the final source candidate.
      Representative final focused evidence: test-drive fences 11 files / 185
      tests; report/privacy lifecycle 6 files / 37 tests; the final combined
      privacy-expiry and terminal-lifecycle recheck 9 files / 117 tests;
      Phase 5 index tooling 7 tests.
- [x] Full regression, TypeScript, lint, production build, module-budget, and
      whitespace checks pass:

  ```text
  npm run test:run                  770 passed / 6 skipped files; 9,682 passed / 18 skipped tests
  npx tsc --noEmit --pretty false   passed
  npm run lint                      passed
  npm run build                     passed (local REDIS_URL/Edge warnings only)
  node scripts/check-module-size.mjs passed
  git diff --check                  passed
  ```

- [x] The protected-boundary comparison is clean for `modules/interview/**`,
      `app/api/interviews/**`, `shared/db/models/**`, and
      `shared/services/ttsCache.ts`.
- [x] The final audit records the exact module budget measurements, focused/full
      test totals, production-build result, and any approved architecture decision
      required by the Phase 5 package shape. Final module measurements: Hire
      90/90 files and 24,345/25,000 LOC; Hire Decisions 18/20 and 4,578/5,000;
      Hire Reports 19/30 and 4,673/10,000; Hire Operations 6/12 and 2,084/3,000;
      Hire Digest 10/18 and 1,198/5,000; Shared 175/180 and 25,391/26,000.

## Index and Inngest release gates

- [x] **Safe index tooling exists locally.**
      [`scripts/prepare-hire-phase5-indexes.ts`](../scripts/prepare-hire-phase5-indexes.ts)
      has a disconnected plan mode, a connected read-only exact-index check, and an
      explicit apply mode. Apply stops before writing on an incompatible same-key
      index or duplicate unique coordinate, then creates only missing exact
      indexes. It never calls `syncIndexes`, `dropIndex`, or a bulk index mutation.
      Operations has no speculative index in this plan.

### Phase 5 index command sequence

```text
npm run prepare:hire-phase5-indexes
npm run check:hire-phase5-indexes
npm run prepare:hire-phase5-indexes -- --apply
```

The first command is plan-only and does not connect to MongoDB. The second is
read-only and must pass against the isolated Hire-control database. Use the
third command only in the approved release window after a compatible missing
index is identified; preserve its output and run the check again. Stop for an
incompatible or duplicate index and approve an explicit migration rather than
bypassing the guard.

### Exact Phase 5 index inventory — 22 total

| Collection                | Count | Schema-declared index purpose                                                                                                  |
| ------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------ |
| `HireCandidateStatusLink` |     3 | issuance idempotency; application lifecycle/expiry; candidate privacy/retention                                                |
| `HireReportExport`        |     5 | request idempotency; job history; recovery/lease/expiry; report-kind history; privacy cleanup                                  |
| `HireReportExportCleanup` |     2 | one cleanup tombstone per export; global cleanup recovery                                                                      |
| `HireDigestPreference`    |     2 | one member preference; enabled-member enumeration                                                                              |
| `HireDigestOutbox`        |     3 | member/period idempotency; due/lease recovery; opt-out cancellation                                                            |
| `HireOnboardingTestDrive` |     7 | operation idempotency; one active member drive (partial unique); cleanup; application/job/candidate/round aggregate exclusions |

The `HireOnboardingTestDrive` active-drive invariant is the only partial unique
index in this inventory: `{ workspaceId, issuedByMemberId, active }` with
`{ active: true }`. The script requires that option exactly; a matching key
without the partial filter is incompatible.

- [P] **Pending final index verification slots.**
  - Isolated Hire-control `check` output for the exact merged SHA.
  - If needed, approved `-- --apply` output showing only missing indexes were
    created, followed by a passing `check` output.
  - Final operator record of the 22 collection/name/key/option results. Do not
    record database credentials or connection strings.

- [x] **Current Hire-control Inngest source manifest — 19 functions.** The
      current control-route manifest contains:
      `hire-email-outbox`, `hire-media-retention`,
      `hire-engine-revocation-retry`, `hire-lifecycle-retention`,
      `hire-resume-intake`, `hire-resume-intake-recovery`,
      `hire-screening-invitation-dispatch`,
      `hire-screening-invitation-recovery`,
      `hire-human-kit-delivery-dispatch`,
      `hire-human-kit-delivery-recovery`,
      `hire-assessment-export-dispatch`, `hire-assessment-export-recovery`,
      `hire-report-export-dispatch`, `hire-report-export-recovery`,
      `hire-daily-digest-dispatch`, `hire-daily-digest-schedule`, and
      `hire-daily-digest-recovery`,
      `hire-onboarding-test-drive-cleanup-requested`, and
      `hire-onboarding-test-drive-cleanup-recovery`.

  The onboarding requested event carries only `{ workspaceId, testDriveId }`.
  Explicit member/test-drive removal emits a best-effort post-commit opaque
  wake-up, while the hourly recovery job remains the durable path for any
  missed dispatch or marker that becomes due during a lifecycle transaction.

- [P] **Pending final Inngest verification slots.**
  - Final source manifest test records the intended 19-function
    control-surface count and names.
  - Deployed `GET /api/inngest` evidence for that exact merged SHA has the same
    control-only manifest; runtime and B2C surfaces expose none of these jobs.
  - Inngest sync/enablement and the intended schedules are confirmed without
    sending customer traffic or recording event payloads, links, or secrets.

## Deployment and controlled internal verification

- [P] Verify the deployed Hire-control health/configuration for the exact merged
  SHA: distinct control database, Redis, private artifact storage, email
  configuration, public-origin/trusted-proxy settings, encryption configuration,
  and Inngest identity are healthy. Do not record secrets in this checklist.
- [P] In an owned internal workspace, create the planned starter job and
  candidates, complete an owned AI interview, and verify the first result is
  reachable in under 15 minutes. Capture only redacted operational evidence.
- [P] In the same workspace, exercise the KPI strip, jobs-health ordering,
  small-n performance fallback, ten-plus-record performance chart, pipeline
  report, close-out report, and CSV export. Confirm their values reconcile to
  the underlying authorized applications and reports contain no internal rank
  or out-of-scope data.
- [P] Open a candidate-status link in a clean browser profile; verify intended
  progression only, no login/cookie dependency, fragment/query handling as
  implemented, history/referrer scrubbing, and uniform inactive behavior after
  revoke, expiry, terminal change, and privacy deletion.
- [P] Exercise the onboarding test drive with an owned account from a new
  workspace through first result. Verify consent first, correct attribution,
  retry behavior, no duplicate candidate/application, and an understandable
  empty/error recovery state.
- [P] Trigger one digest in a controlled window using a controlled mailbox.
  Verify one correct authorized recipient and summary, stable idempotency under
  retry, no send after membership/workspace/privacy shutdown wins its fence, and
  a privacy-safe audit receipt.
- [P] Observe at least one normal report-generation/cleanup lifecycle and one
  privacy or workspace-deletion lifecycle. Confirm pending work cancels, private
  artifacts are inaccessible/deleted on schedule, status links fail closed, and
  no deferred email/report event reintroduces erased data.

## Completion decision

- [x] Source implementation and adversarial/local automated audits are complete.
- [x] Final repository gates and protected-boundary comparison are complete.
- [ ] Phase 5 indexes and Inngest registration are verified in Hire-control.
- [ ] Controlled internal operations, reports, CSV, candidate-status, onboarding,
      audit, digest, and lifecycle checks pass.
- [ ] Phase 5 can be marked complete.

Until those items are closed, Phase 5 is implementation-ready at most; it is
not production-complete. No customer pilot is a prerequisite for this phase.
