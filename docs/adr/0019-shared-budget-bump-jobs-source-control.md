# ADR 0019: shared maxFiles 149→152 — Jobs source-control records

Date: 2026-07-21 · Status: accepted · Relates: Jobs audit A02, ADR 0016/0018

## Context

Jobs audit phase A02 makes source revocation an auditable, monotonic control
operation. It adds two counted files under `shared/db/models/`:

- `JobSourceControlAudit.ts` is the permanent append-only evidence for every
  revoke/restore transition, uniquely keyed by operation and source revision.
- `JobSourceControlMeta.ts` is the singleton global control-serialization fence
  and lineage-migration readiness marker. Deleted/reseeded source-config resets
  are rejected separately by the latest permanent audit check in the writer.

Both collections participate in Mongo transactions with `JobSourceConfig` and
`JobPosting`. Repository convention keeps persistence models in `shared/`; moving
them into `modules/jobs` would break the existing shared model barrel and create
an inconsistent ownership rule for Jobs persistence.

The branch raises the counted shared files from 149 to 151. Shared LOC remains
well below its 25,000-line budget.

## Decision

Raise `shared.maxFiles` from 149 to 152: two slots for the required persistence
models and one slot of headroom. The LOC budget is unchanged. This is legal-
control state, not general utility or UI sprawl, and each collection has a
separate lifecycle and index contract that should not be collapsed into an
unrelated model file merely to evade the tripwire.

## Consequences

- CI's module-size check passes with A02 while retaining only one file of
  headroom.
- The next shared addition must reopen the architectural budget discussion.
- The source-control models remain independently indexable and auditable.
- Their five legal-control indexes are prepared by an explicit, idempotent
  `createIndex`-only operator command before migration/adoption. Schema-wide
  reconciliation (`syncIndexes`) and index deletion are excluded from the
  rollout; a TTL on permanent audit evidence blocks promotion.
