# ADR 0047: Isolate durable Hire candidate bulk actions

**Status:** Accepted
**Date:** 2026-08-25

## Context

A job can receive 500–1,000 applications. Applying a stage action from one
browser request would couple an unbounded candidate list, an expiring user
session, and a long database mutation. It would also make partial completion,
privacy changes, concurrent stage edits, and retry behavior ambiguous.

The existing interactive pipeline service remains the authority for one stage
transition. It is not a queue, selection store, or bulk-operation ledger.

## Decision

Create the bounded `modules/hire-candidate-actions` control-plane module. It:

- accepts only a server-owned immutable selection snapshot (maximum 5,000);
- persists the operation and every row's expected stage in one transaction;
- exposes only advance, reject, and withdraw—never bulk hire or offer outcome;
- requires a controlled, non-PII reason code for reject/withdraw and records
  that no communication will be sent;
- processes ten rows per event with stable per-row idempotency coordinates,
  bounded leases/retries, and tenant-fair recovery;
- rechecks workspace, membership, job, stage, candidate, and privacy authority
  before each mutation and reports controlled per-row conflicts;
- emits only opaque workspace/operation coordinates to Inngest; and
- unlinks candidate coordinates transactionally at privacy/retention boundaries;
- retains per-row troubleshooting coordinates for 90 days and aggregate,
  non-identifying operation audit for 365 days; and
- participates in transactional workspace purge.

Runtime schemas disable automatic collection and index creation. All indexes
are owned by the explicit Hire-control preparer and must pass exact preflight,
apply, and post-apply checks before the feature receives production traffic.

## Boundaries

The module may call the existing single-row `moveStage` command with its
privacy fence enabled. It does not own candidate search, selection evaluation,
screening invitations, decisions, email delivery, or offer acceptance.
Responses are private/no-store and never contain candidate PII or raw provider
errors.

The initial budget is 2,000 production LOC and 12 production files. The
release implementation measures 1,674 LOC across nine files.
Growth beyond that envelope requires a structural split and a new ADR.

## Consequences

Bulk actions are resumable and honest about partial outcomes, while the normal
single-candidate command remains the sole stage-transition authority. The
trade-off is two new persistence collections, explicit indexes, a recovery
worker, and operational progress UI rather than an immediate all-or-nothing
response.
