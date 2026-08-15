# IPG Hire Phase 3 — Human Rounds Readiness Checklist

**Scope:** human rounds via interviewer kits, as defined in [the build plan](./ipg-hire-build-plan.md#phase-3--human-rounds-via-interview-kits). This checklist records evidence from the current local worktree. It is not evidence that a production email, Inngest job, database index, or deployed route has run.

**Current audit state:** **local implementation and repository gates are complete.** The source-level findings below are resolved and covered locally. The remaining items are controlled deployment and internal verification checks; this plan does not require a customer pilot.

## Release blockers found in the source audit

- [x] **P1 — make terminal kit-delivery failure visible to HR.** A terminal initial-delivery failure now writes the bounded `human_kit_delivery_failed` application event, and the member card receives a safe delivery summary. The UI provides recovery guidance without exposing recipient data, provider errors, or a capability.

- [x] **P1 — render submitted human scorecard evidence on the candidate card.** The application detail projection serializes each submitted per-round scorecard only to authenticated workspace members, and the card renders its fixed ratings, recommendation, and evidence without Phase 4 aggregation.

## Implementation traceability

The entries below mean the local source contains the stated implementation. They do not replace the deployment checks in the next section.

| Build-plan item                                                                    | Local implementation evidence                                                                                                                                                      | Status                                                                  |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| HR logs a guest round and sends an interviewer kit automatically                   | Authenticated create route; transactional `HireHumanRound`, hash-only `HireInterviewKit`, encrypted durable initial delivery; ID-only Inngest wake-up                              | Present locally                                                         |
| Tokenized, expiring, no-login kit page                                             | `/interview-kit/[kitId]` stores a fragment capability only in tab storage, scrubs browser history, and calls cookie-free bootstrap/submit endpoints                                | Present locally                                                         |
| Brief plus fixed scorecard                                                         | Least-disclosure brief and four fixed dimensions (`role_capability`, `problem_solving`, `communication`, `collaboration`), with one-use scorecard submission                       | Present locally                                                         |
| Member-run interview room logs the round on opening                                | Application card can create a `member_room` round, then submit the member's own draft scorecard                                                                                    | Present locally                                                         |
| Round/pending chips                                                                | Job board renders distinct human-round summary chips; application card renders lifecycle rows and submitted per-round scorecard evidence                                           | Present locally                                                         |
| One reminder for a pending scorecard                                               | Recovery sweep creates at most one reminder after a sent initial email has been pending for at least 24 hours; its capability envelope is re-sealed under reminder-specific AAD; unique delivery purpose/index prevents duplicates | Present locally; final-attempt leases terminalize without re-egress |
| Expiry, revocation, privacy, close, terminal-stage, and workspace lifecycle fences | Human records are revoked/cancelled or deleted alongside the relevant Hire lifecycle decision, without entering the AI runtime path                                                | Present locally                                                         |
| Tenant and public-surface isolation                                                | Workspace-scoped records, no capability in normal member APIs, no public route on the runtime surface, no-cookie public routes, no-store/no-referrer headers, dual rate limits, and privacy-safe delivery logging | Present locally |
| Async queue and recovery                                                           | `hire/human-kit.requested` plus delivery and recovery Inngest functions are registered on the Hire-control surface                                                                 | Present locally                                                         |
| Required MongoDB indexes                                                           | Explicit non-dropping planning, checking, and apply script with duplicate/incompatible-index preflight                                                                             | Present locally; not yet applied or checked against a deployed database |

## Completed local automated evidence

The following focused checks passed in this worktree on 2026-08-13:

```text
npx vitest run --reporter=dot \
  modules/hire/__tests__/humanRoundModels.test.ts \
  modules/hire/__tests__/phase3HumanRoundValidators.test.ts \
  modules/hire/__tests__/humanRoundService.test.ts \
  modules/hire/__tests__/humanKitDeliveryService.test.ts \
  modules/hire/__tests__/humanKitDeliveryJob.test.ts \
  app/api/interview-kit/[kitId]/__tests__/guestKitRoutes.test.ts \
  app/interview-kit/[kitId]/__tests__/interview-kit-entry.test.tsx \
  app/(workspace)/workspace/applications/[appId]/__tests__/HumanRoundsPanel.test.tsx \
  app/api/workspace/applications/[appId]/human-rounds/__tests__/route.test.ts \
  app/api/workspace/human-rounds/[roundId]/__tests__/route.test.ts \
  app/api/inngest/__tests__/route.test.ts \
  scripts/__tests__/prepare-hire-phase3-indexes.test.ts

12 test files passed; 54 tests passed.
```

```text
npx vitest run --reporter=dot \
  modules/hire/__tests__/pipelineService.test.ts \
  modules/hire/__tests__/candidateRetentionService.test.ts \
  modules/hire/__tests__/privacyDeletionService.test.ts \
  modules/hire/__tests__/workspacePurgeService.test.ts \
  modules/hire/__tests__/workspaceService.test.ts \
  modules/hire/__tests__/tenantIsolation.test.ts \
  modules/hire/__tests__/controlRouteIsolation.test.ts \
  modules/hire-runtime/__tests__/runtimeRouteIsolation.test.ts \
  __tests__/middleware.test.ts \
  shared/surfaces/__tests__/hireSurfaceIsolation.test.ts \
  shared/analytics/__tests__/track.test.ts \
  shared/layout/__tests__/RootSurfaceComposition.test.tsx

12 test files passed; 223 tests passed.
```

Those suites exercise model invariants, fixed-scorecard validation, capability handling, public-route headers/rate limits, durable delivery/recovery behavior, member UI behavior, index-script safeguards, tenant isolation, lifecycle shutdown, and control/runtime route isolation. They do **not** establish live provider delivery, an Inngest Cloud registration, or MongoDB index state.

The final repository-wide internal gate run passed on 2026-08-14:

```text
npx vitest run --reporter=dot
  692 test files passed; 6 skipped
  9,292 tests passed; 18 skipped

npx tsc --noEmit --pretty false
npm run lint
npm run build
node scripts/check-module-size.mjs
git diff --check
```

All commands above exited successfully. The module boundary is within the Phase 3 ADR budget at 82/90 Hire files and 22,773/25,000 LOC; the protected interview-engine and B2C paths are unchanged versus `origin/main`.

## Pending deployment and internal-production checks

- [x] Resolve both source-level release blockers above and add focused regression coverage for each.

- [x] Run the repository's agreed full lint/type/build gates on the final working tree. Re-run the relevant checks if the commit scope changes; do not waive a Phase 3 error.

- [ ] Confirm the Hire-control deployment has a distinct configured control database, `IPG_SURFACE=hire-control`, the existing delivery-encryption key configuration, transactional-email configuration, a correct `HIRE_PUBLIC_URL`, and Inngest production keys/app identity. Do not place a kit capability or recipient PII in logs, dashboards, or event payloads.

- [ ] In the controlled Hire-control environment, run `npm run prepare:hire-phase3-indexes` first (plan only), then `npm run prepare:hire-phase3-indexes -- --apply`, followed by `npm run check:hire-phase3-indexes`. Preserve the operator output; the apply command intentionally refuses incompatible indexes and duplicates rather than repairing them destructively.

- [ ] Deploy the control surface and verify its `/api/inngest` registration contains both human-kit functions: the ID-only requested-delivery handler and the recovery sweep. Confirm the runtime surface still does not expose public kit routes or human delivery jobs.

- [ ] Perform an internal synthetic end-to-end check with an owned test workspace, test candidate, and controlled mailbox:

  1. Create a guest human round from the authenticated application card.
  2. Verify a durable delivery row transitions to `sent` and the application has an accurate HR-visible delivery receipt.
  3. Open the received `#kit=…` URL in a clean browser profile; verify no login is requested, the fragment is removed from browser history, and the brief is least-disclosure.
  4. Submit all four scorecard dimensions, recommendation, and evidence; verify the kit is consumed and the submitted scorecard/evidence appears only to authenticated workspace members.
  5. Verify a repeated submission, revoked link, expired link, terminal application, job close, privacy request, and deleted workspace each return the same inactive public state and create no new email.

- [ ] In a controlled test window, verify exactly one reminder is issued only after a successfully sent initial kit remains pending for at least 24 hours. Verify it is suppressed after submission/revocation/lifecycle shutdown and that provider retries use the stable delivery idempotency key.

- [ ] Exercise an email-provider rejection and encryption-recovery failure. Verify HR receives the new non-silent failure signal, the row retries only within its configured bound, and no raw capability appears in event payloads or logs.

- [ ] Observe delivery/recovery queues and application audit receipts through at least one normal expiry window. Investigate any stuck `sending`, permanently `failed`, or uncancelled lifecycle row before marking the phase complete.

## Explicitly out of Phase 3 scope

The following remain Phase 4+ work and must not be used as a Phase 3 completion criterion: recommendation aggregation, reviewer averages/spread, share packets/external verdicts, comparison screens, assessment PDFs, report exports, and automatic stage moves. Human evidence is for member review; no AI or automation may move a candidate stage.

## Completion decision

- [x] Source blockers resolved and tested.
- [x] Local repository gates pass for the final working tree.
- [ ] Indexes, deployment configuration, and Inngest registration verified on the target control environment.
- [ ] Internal synthetic kit → own meeting → scorecard → visible evidence path passes, including one reminder and failure/revocation checks.
- [ ] Phase 3 can be marked complete.
