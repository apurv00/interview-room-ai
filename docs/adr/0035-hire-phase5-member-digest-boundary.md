# ADR 0035 — IPG Hire Phase 5 member-digest boundary

Date: 2026-08-14
Status: accepted
Supersedes: none

## Context

Phase 5 needs a daily operational summary for authenticated Hire workspace
members. The old B2C learning digest is intentionally hard-disabled: it lacks
per-user delivery idempotency, safe pagination, and an opt-in policy. The
existing `HireEmailOutbox` is also unsuitable because it is a
candidate/application/job-close record with candidate privacy lifecycle
semantics.

Reusing either path would blur recipient authority, make retry behavior hard
to audit, and risk putting candidate PII or public capabilities into routine
member mail.

## Decision

Create `modules/hire-digest` with an initial CI budget of **5,000 counted LOC
/ 18 counted files**. It owns:

- an explicit **opt-in, off-by-default** per-workspace-member preference;
- a durable outbox unique on `{ workspaceId, memberId, UTC periodKey }`, with
  retry/lease state and deterministic provider idempotency;
- an immutable aggregate-only content snapshot (`openJobs`, pending work,
  aggregate blockers) and a pure escaped email template; and
- an exact pre-egress transaction that writes active workspace, active member,
  opt-in, and outbox fences before calling the provider.

The worker and recovery path may carry only `workspaceId` and `outboxId`.
Member email/name, provider identifiers, and the snapshot are never placed in
an event, a public/member DTO, or ordinary logs. All sends use the existing
privacy-safe email logging option.

The module uses `@hire-digest-boundary`, a direct facade over the Hire control
models and lifecycle predicates. It must not import the root `@hire` barrel,
B2C user models, the Learn digest, candidate email outbox, interview engine,
or public capability services.

## Consequences

- Existing workspace members receive no mail merely because Phase 5 deploys;
  they opt in from the authenticated workspace UI.
- UTC is the declared period policy until a validated per-workspace IANA time
  zone is introduced. A future timezone feature must migrate period identity
  deliberately rather than silently changing dedupe behavior.
- Member removal, self-deletion, workspace deletion, privacy/retention policy,
  and hard purge must cancel unfinished rows in their same lifecycle
  transactions. A worker that loses one of those fences sends nothing.
- A read-only audit projection may expose only safe digest lifecycle receipts
  (period/status/time/member actor), never recipient data or content.
