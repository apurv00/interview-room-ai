# ADR 0021: shared maxFiles 154→157 — Jobs operations and pinned transport

Date: 2026-07-22 · Status: accepted · Relates: Jobs audit A08, ADR 0019/0020

## Context

Jobs audit phase A08 adds two shared production files:

- `JobSourceOperationAudit.ts`, a permanent record of source bootstrap,
  enable, pause, validation, settings, and run-now commands; and
- `pinnedHttpClient.ts`, the common resolve-once, global-address-only,
  DNS-pinned and response-capped provider transport used across Jobs adapters.

Repository convention keeps Mongo persistence models under `shared/db/models`.
The network primitive belongs in `shared` because it hardens the existing
shared JSON request helper and prevents adapters from reimplementing socket
pinning inconsistently.

This evidence cannot share `JobSourceControlAudit`: that existing collection is
the legal revoke/restore chain, and its complete-history check requires strict
action alternation and revision parity. Mixing routine operations into it would
invalidate the A02 legal-authority invariant. Product events are also unsuitable
because they expire and do not provide command idempotency.

The two files take shared from 154 to 156 counted files. Shared LOC remains
well below its 25,000-line budget.

## Decision

Raise `shared.maxFiles` from 154 to 157: one slot for each production file and
one slot of headroom. The LOC budget is unchanged. Tests under `__tests__` do
not count toward this repository's file budget.

## Consequences

- CI permits the distinct permanent audit lifecycle required by A08.
- Provider adapters share one pinned, bounded egress primitive.
- Legal revoke/restore evidence remains isolated and parity-safe.
- The next shared addition must reopen the budget discussion.
- Operational-audit indexes remain explicit deployment/bootstrap gates and
  must never receive a TTL.
