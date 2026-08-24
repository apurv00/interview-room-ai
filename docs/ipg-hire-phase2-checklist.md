# IPG Hire — Phase 2 (Volume + Screening) checklist

Plan of record: [IPG Hire build plan](./ipg-hire-build-plan.md), Phase 2 — Volume + Screening. The similarly named [PHASE_2_PLAN.md](./PHASE_2_PLAN.md) is a separate B2C growth plan, not this Hire plan of record.

Status legend: [x] implemented with named automated evidence; [P] required deployment or live proof; [ ] unresolved release blocker. This checklist does not claim a production-complete Phase 2 until every [P] and [ ] item is closed.

## Build-plan ships

- [x] **Bulk resume upload on an async queue.** The job page admits at most 50 PDF, DOCX, or TXT files per batch, submits durable Hire-owned tasks at three request uploads at a time, and polls status. Parsing, identity extraction, JD scoring, and candidate/application writes happen in a worker; recovery sweeps retry due work. Evidence: BulkUploadPanel, HireIntakeTask, intakeQueueService, intakeJob, and their UI, route, service, and model tests.

- [x] **Automated volume composition proof.** `phase2BulkResumeFlow.test.ts` runs 50 durable upload tasks through the real queue worker, Hire intake/dedupe service, and ranked-pipeline reader with deterministic local adapters: all 50 parse and score without a manual identity step, one duplicate email produces 49 workspace candidates/applications, and the ranked queue, prior-job flag, ID-only events, and payload scrubbing are asserted.

- [x] **Public apply page per job, no login.** A member creates or rotates a hashed, job-scoped capability. The public route produces a uniform outcome for invalid or revoked capabilities and queues rather than directly writes an application. The raw capability is neither stored nor put into an Inngest event. Evidence: applyPageService, app/api/apply/route.ts, and their tests.

- [x] **Auto JD-match scoring and ranked queue.** Intake binds a match result to the exact resume. The pipeline ranks fresh scores deterministically and places stale or unscored records below them. Evidence: jdMatchService, intakeService, pipelineService, jdMatchService.test.ts, intakeService.test.ts, and pipelineService.test.ts.

- [x] **Email dedupe and previously-seen context.** Candidate identity is normalized and unique within a Hire workspace. The same candidate can be reused for another job and has workspace-local prior-job and stage context; a candidate in another tenant remains invisible. Evidence: HireCandidate, pipelineService, duplicateJobPoolService, pipelineService.test.ts, duplicateJobPoolService.test.ts, and tenant-isolation tests.

## Phase 2 screening and safety work

- [x] **Human-confirmed screening gate.** HR reviews a tenant-scoped deterministic preview; confirmation freezes the requirement version, ranking, selection evidence, and unsent invitation batch. Known location/experience failures can be excluded, unknown data remains eligible, and no candidate is auto-rejected. Evidence: screeningService, screeningGateService, preview/confirm routes, and their tests.

- [x] **Durable invitation batches and waterfall.** Items have bounded leases and retries, a one-minute recovery sweep, privacy-redaction handling, and a manual waterfall that cannot undo a documented exclusion. Round creation and provider egress each take a transactional non-terminal application fence, so a Reject, Withdraw, or Hire decision that wins the race prevents a new invite or later delivery. Evidence: HireInvitationBatch models, screeningInvitationService, screeningInvitationJob, aiRoundService, aiInviteDeliveryService, hireApplicationDispatchFence, and tests.

- [x] **Workspace-lifecycle egress safety.** Job-close rejection takes a transaction-bound active-workspace write fence immediately before leasing the exact outbox row for provider delivery. Soft deletion writes the same workspace root and cancels tenant-scoped pending, sending, and failed outbox rows in that transaction. If deletion wins the write race, no provider request is made; authorization that wins first is explicitly a pre-deletion send. Evidence: emailOutboxService, workspaceService, emailOutboxService.test.ts, and workspaceService.test.ts.

- [x] **Bounded raw-resumé retention.** A resume with no reliable email enters needs_identity, but no queued, identity-pending, or abandoned leased raw payload can outlive seven days. The recovery sweep cancels and scrubs expired payloads tenant-by-tenant; claim, model-egress, identity-supply, and persistence fences reject work that crosses the deadline. Evidence: intakeQueueService, intakeJob, and their tests.

## Hard boundaries

- [x] **The original Phase 2 implementation left the interview engine and B2C persistence untouched.** At the Phase 2 candidate baseline, its scoped diff from `origin/main` was empty for `modules/interview/`, `app/api/interviews/`, `shared/db/models/`, and `shared/services/ttsCache.ts`. Later combined cleanup work is outside this historical Phase 2 boundary.

- [x] **Candidate identity stays Hire-owned.** Candidate email is not resolved against B2C User. Public intake and worker authority use Hire workspace/member records and hashed capabilities. Evidence: applyPageService.test.ts, intakeQueueService.test.ts, and tenantIsolation.test.ts.

- [x] **Tenancy and privacy scope are preserved.** Queue/task, pool, screening, invitation, privacy, retention, and purge operations use exact workspace coordinates. Privacy-redacted invitation rows lose direct candidate/application references. Evidence: tenantIsolation.test.ts, privacyDeletionService.test.ts, candidateRetentionService.test.ts, and workspacePurgeService.test.ts.

## Automated evidence to re-run on the candidate commit

Focused Phase 2 behavior:

    npx vitest run modules/hire/__tests__/applyPageService.test.ts \
      modules/hire/__tests__/intakeQueueService.test.ts \
      modules/hire/__tests__/phase2BulkResumeFlow.test.ts \
      modules/hire/__tests__/intakeJob.test.ts \
      modules/hire/__tests__/hireIntakeTaskModel.test.ts \
      modules/hire/__tests__/intakeService.test.ts \
      modules/hire/__tests__/jdMatchService.test.ts \
      modules/hire/__tests__/pipelineService.test.ts \
      modules/hire/__tests__/duplicateJobPoolService.test.ts \
      modules/hire/__tests__/screeningModels.test.ts \
      modules/hire/__tests__/screeningService.test.ts \
      modules/hire/__tests__/screeningGateService.test.ts \
      modules/hire/__tests__/screeningInvitationService.test.ts \
      modules/hire/__tests__/screeningInvitationJob.test.ts \
      modules/hire/__tests__/aiRoundService.test.ts \
      modules/hire/__tests__/aiInviteDeliveryService.test.ts \
      modules/hire/__tests__/emailOutboxService.test.ts \
      modules/hire/__tests__/workspaceService.test.ts \
      modules/hire/__tests__/privacyDeletionService.test.ts \
      modules/hire/__tests__/candidateRetentionService.test.ts \
      modules/hire/__tests__/workspacePurgeService.test.ts \
      app/api/apply/__tests__/route.test.ts \
      app/apply/__tests__/apply-client.test.tsx \
      'app/api/workspace/jobs/[jobId]/intake/__tests__/route.test.ts' \
      'app/api/workspace/jobs/[jobId]/intake/[taskId]/__tests__/route.test.ts' \
      'app/api/workspace/jobs/[jobId]/screening/__tests__/route.test.ts' \
      'app/api/workspace/jobs/[jobId]/screening/__tests__/serialize.test.ts' \
      'app/(workspace)/workspace/jobs/[jobId]/__tests__/BulkUploadPanel.test.tsx' \
      'app/(workspace)/workspace/jobs/[jobId]/__tests__/PoolSuggestionPanel.test.tsx' \
      'app/(workspace)/workspace/jobs/[jobId]/__tests__/ScreeningPanel.test.tsx' \
      'app/(workspace)/workspace/jobs/[jobId]/__tests__/page.test.tsx'

Index-rollout guard:

    npx vitest run scripts/__tests__/prepare-hire-phase2-indexes.test.ts \
      scripts/__tests__/hirePhase2IndexOwnership.test.ts

Regression and release checks:

    npx vitest run
    npx tsc --noEmit --pretty false
    npm run lint
    npm run build
    git diff --check
    git diff --stat origin/main -- modules/interview app/api/interviews shared/db/models shared/services/ttsCache.ts
    npx vitest run shared/surfaces/__tests__/hireDeploymentReadiness.test.ts

## Release and deployment gates

- [x] **Module-size architecture gate.** The current bounded Phase 2
  envelope is **92 files / 28,100 LOC** for `modules/hire`, preserving the
  distinct queue, screening, invitation, and privacy lifecycle
  seams. Measured implementation is **92 files / 28,097 LOC**; `node
  scripts/check-module-size.mjs` passes. Future growth must remain within
  that tripwire or receive a new architectural decision.

- [P] **Control configuration.** The deployed hire-control manifest must pass hireDeploymentConfigurationIssues and preserve control/runtime database, origin, and Inngest-ID separation.

- [P] **Public-ingress trust and upload compatibility.** The control origin must accept traffic only through the configured trusted proxy, which overwrites client-IP headers. The apply route prefers provider-owned Vercel/Cloudflare client-IP headers and puts malformed identity in a bounded shared rate-limit bucket; direct-origin access would make any forwarding header forgeable. Prove the deployed proxy sends a normal browser multipart request with Content-Length before the pilot, because the public upload route rejects missing lengths rather than accept an unbounded body.

- [P] **Inngest registration and recovery.** Deploy the control surface and sync GET /api/inngest with the control app. Verify hire-resume-intake, hire-resume-intake-recovery, hire-screening-invitation-dispatch, and hire-screening-invitation-recovery are registered/enabled, minute recovery runs, and events contain only durable IDs.

- [P] **Control indexes and conditional legacy invitation migration.** `npm run prepare:hire-phase2-indexes` is a locally verified plan-only command: it prints 14 exact target definitions and opens no database connection or index write. The set includes the bounded screening-recipient read index, the authoritative-result aggregate index, and the optional commercial-account uniqueness index. The three new indexes are deliberately absent from runtime schema initialization. Before the new control image handles traffic, run `npm run check:hire-phase2-indexes` against the target control database; review the missing-index report, run `npm run prepare:hire-phase2-indexes -- --apply` only with release approval, then require a passing `--check`. The apply path preflights every key and name collision before the first write, creates only exact missing indexes, and never drops or synchronizes indexes. If it detects the legacy full unique HireInvitationBatchItem workspaceId/applicationId index or duplicate workspace commercial accounts, it fails the complete preflight before writes. For the legacy invitation index, pause screening creation/dispatch, back up and inspect that index and data, confirm redacted rows have no applicationId, replace the exact legacy full index with the partial index, verify it, then resume. A fresh deployment with no prior collection needs no data migration, but still requires the explicit apply/check gate.

- [P] **Provider/privacy and lifecycle smoke test.** In deployed control, prove verified candidate deletion prevents pending intake/invitation work from re-emitting PII, and workspace deletion that wins the egress claim prevents close-rejection provider sends or retries.

## Build-plan done-when proof — intentionally still pending

- [P] **One real controlled 50-resume batch, end to end, with zero manual steps.** The build plan requires “50 resumes parsed, scored, ranked, and deduped with zero manual steps.” The local 50-task composition test and 50-file UI limit are not deployed end-to-end proof. On deployed control:

  1. Create one open job and submit one 50-file authorized test/pilot batch with a documented duplicate subset.
  2. Do not manually add candidates, supply missing identities, replay a worker by hand, or alter queue/application data; let the durable event/recovery workers finish.
  3. Preserve non-PII evidence that all 50 tasks completed (none needs_identity, failed, or cancelled), every final non-duplicate application has a fresh current-resume score, and duplicate normalized emails created no duplicate candidate/application for that job.
  4. Capture the ranked pipeline through its bottom, task/candidate/application counts, duplicate source-history proof, deployed commit, job ID, task counts/IDs, time window, worker runs, and redacted screenshots/exports.

Until that live batch and all release gates are recorded, Phase 2 is implementation- and automation-ready only, not complete.
