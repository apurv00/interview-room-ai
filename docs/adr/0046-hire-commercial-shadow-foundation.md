# ADR 0046 — Hire commercial shadow foundation

## Status

Accepted — 2026-08-23

## Context

Hire currently ships one undivided capability surface. Product packaging needs
a stable vocabulary and usage evidence before pricing, checkout, or entitlement
enforcement can be designed safely. A commercial rollout must not silently lock
existing workspaces, create a second candidate-linked ledger, or make core
result ingestion depend on optional commercial persistence.

## Decision

- Create a bounded `modules/hire-commercial` module with a versioned Core,
  Screen, Decide, and Operate catalog.
- Treat a missing commercial account as compatibility full access. Persisted
  account selections are shadow metadata only; no application or API capability
  is gated in this tranche.
- Expose only an admin-only, private/no-store GET projection and a read-only
  `/workspace/modules` preview. The only action is “Request pilot”; there is no
  checkout or mutation route.
- Derive `screenAssessmentsCompleted` at read time from the authoritative,
  workspace-scoped `HireInterviewResult` collection, bounded by the versioned
  `2026-08-23T00:00:00.000Z` measurement epoch. One result already represents
  one completed assessment across duplicate and media-only revisions.
- Add no commercial usage receipt, result-ingestion hook, candidate coordinate,
  or write-path dependency. Privacy-discard and stale ingestions never create
  an authoritative interview result and therefore are absent naturally.
- Delete the optional commercial account inside the workspace graph-purge
  transaction before deleting the workspace root.

The admin projection includes only the aggregate number of Screen completions
at or after the versioned epoch and that epoch. It is explicitly not a lifetime
total or a bill, and it never returns result, candidate, application, round,
attempt, member, email, or contact coordinates.

The fixed epoch is the complete reconciliation rule for this read-only shadow
metric. Before entitlement enforcement, invoicing, or a usage limit can ship, a
separate ADR must define a billable event authority, correction policy, and
auditable rollout. The aggregate shadow query is not that authority.

The explicit Hire-control index preparer exclusively owns the account
uniqueness index and the workspace/completed-at result index. Those indexes are
not declared for runtime schema initialization. A release must run plan, apply,
and check against the target control database before the new image handles
traffic; the preparer rejects key or name collisions before any write and never
drops or synchronizes indexes.

## Boundary and budget

The module may own catalog, commercial account, aggregate read projection, and
a narrow purge seam. It may not own checkout, payment collection, candidate or
application records, result-ingestion writes, entitlement middleware, or
current-feature gates.
Its initial CI budget is 2,000 source LOC and 12 counted files.

## Consequences

The product can validate module language and volume assumptions without changing
customer access. A later enforcement or payment phase requires a separate ADR,
migration policy, pricing authority, and explicit rollout plan.
