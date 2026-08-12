# IPG Hire — Phase 1 (The Spine) completion checklist

Plan of record: the task-supplied `ipg-hire-build-plan (1).md` dated August 2026. This checklist is deliberately evidence-based: a checked item has current automated or live evidence; an unchecked item still needs the named action. It is not a claim that the pilot is complete.

## Phase 1 ships

- [x] **Workspace and direct member add.** A workspace has one transferable admin; an admin can add a named member by email, the member sets a password on first sign-in, and access/session revocation is immediate. Covered by `memberAuthService`, `workspaceService`, member lifecycle tests, and the live control surface.
- [x] **Create job → Smart JD.** Job creation persists both the prose JD and immutable structured requirement version used by the candidate match and runtime handoff configuration. Covered by `jdBuilderService` and pipeline tests.
- [x] **Manual candidate add.** Candidate and application creation are workspace-scoped, transactionally deduplicated, and retain the member actor snapshot. Covered by intake and pipeline tests.
- [x] **AI interview invite, consent, and copy-link recovery.** An invite is hashed at rest, expires/revokes, sends through the durable outbox, and has an authenticated copy/retry recovery path. Consent is recorded before any runtime ticket is issued. The controlled production run created and redeemed a live invitation.
- [x] **Identity photo at interview start.** The candidate flow captures live camera output only, writes it as a private Hire media asset, and persists the ready asset before handoff. The controlled live run stored and read back the photo from private storage with matching dimensions and checksum.
- [x] **Evidence-linked candidate result.** The isolated runtime now publishes a completed result through the signed control bridge. The controlled live run produced one processed ingestion event, one linked result, three uniquely cited questions/evidence moments, three dimensions, and six findings. An active recruiter card revalidates its private no-store detail response every 15 seconds and stops once publication reaches a terminal state.
- [x] **Human stage moves and close behavior.** Stage transitions use expected-from CAS and actor/name snapshots; hired and job-close actions require a note; job close creates durable rejection-email outbox work. Covered by pipeline and email-outbox tests.

## Goal 2 — engine seams and zero B2C writes

- [x] **Engine internals remain unchanged.** `git diff origin/main...HEAD` is empty for `modules/interview/`, `app/api/interviews/`, `shared/db/models/`, and `shared/services/ttsCache.ts`.
- [x] **Bounded bridge only.** The control service issues a one-time handoff; the isolated runtime provisions a synthetic principal and session; results return through a versioned HMAC-authenticated bridge keyed by workspace, application, round, and runtime session.
- [x] **No Hire result writes in B2C.** The live run’s B2C baseline hashes were unchanged after completion and result publication: the immutable user document and its 1,307 B2C interview sessions matched their pre-run canonical checksums exactly.
- [x] **Reliable completion path.** Runtime completion, feedback recovery, result publishing, control ingestion, and duplicate-safe acknowledgement are all durable and retryable. The live result initially retried after a validation failure, then published exactly once after the fixed control adapter deployed.

## Goal 3 — identity separation and tenancy

- [x] **Candidate identity is Hire-owned.** Candidate email is never resolved against a B2C user. Candidate access uses a hashed, expiring, revocable workspace/round capability; the runtime uses a synthetic non-routable principal.
- [x] **Tenant isolation.** Hire child collections carry immutable `workspaceId`; control and runtime operations use it in their filters; two-tenant and cross-workspace rejection tests cover control, runtime, media, privacy, and capability paths.
- [x] **Guest capability safety.** Credentials travel in URL fragments, are scrubbed before network use, are scoped to one candidate/round, and legacy credential transport returns terminal responses.
- [x] **Lifecycle and privacy.** Verified deletion, soft workspace deletion, and hard-purge workflows revoke guest access, purge scoped personal data and media, retain only permitted aggregate/audit information, and are covered by retention, purge, and race tests.

## Goal 9 — production deliverability and operations

- [x] **Production topology.** Control and runtime are independently deployed and healthy on the same commit `3814336fe5b3761e053c63a84b6efe399fe6dd02`; each reports healthy configuration, MongoDB, Redis, and its expected surface.
- [x] **Async operations.** Control registers its Hire jobs and runtime registers feedback-recovery/result-publisher jobs. The live completed session was published by the scheduled publisher without a forced replay.
- [x] **Transactional email and recovery.** Invite and job-close messages use durable provider-idempotent outbox records; failed sends are visible and retryable by an HR member; invite recovery has a copy-link fallback.
- [x] **DNS authentication is published.** The sending domain has observable SPF, DKIM, and DMARC records; the transactional provider accepted the controlled invite and stored its provider message identifier.
- [x] **Private media.** Identity media is private, served through signed expiring URLs, and scheduled for six-month post-close purge; candidate PII anonymizes after the retention window or immediately after verified deletion.

## Verification record

- [x] **Automated validation.** On commit `73389d83`: `npx vitest run` passed 9,056 tests (18 skipped); `npx tsc --noEmit --pretty false`, `npm run build`, `git diff --check`, and the protected-path diff check all passed. The recruiter refresh follow-up at `3814336f` passed its focused UI tests, TypeScript, ESLint, production build, and whitespace checks.
- [x] **GitHub CI.** PR #620 is clean and its CI and commit-message checks passed for `3814336f`.
- [x] **Live AI spine to evidence.** The controlled production candidate completed the interview; runtime feedback existed; control ingested a single result and linked it to the application with valid evidence references.

## Remaining done-when gates

- [x] **Human decision and job close in the controlled live job.** A member deliberately advanced the candidate, recorded the accepted-offer decision and required decision note, then closed the job with a close note. The live audit confirmed the `offer → hired` and `open → closed` events, actor/member snapshots, legacy user pointers, operation IDs, and notes. No job-close rejection outbox row was expected because the controlled candidate was hired.
- [ ] **Real-company pilot.** A company must perform the full workflow in production, including its own decision and close action. This cannot be inferred from code or a synthetic controlled run.
- [x] **Mailbox receipt evidence.** The controlled candidate confirmed receiving the invitation email and used that invitation to complete the live interview. Provider acceptance and DNS authentication were already independently verified; raw provider delivery telemetry is not required for this direct recipient evidence.

When the remaining real-company pilot has evidence, update the unchecked row rather than treating the controlled run as a substitute for it.
