# ADR 0020: shared maxFiles 152→154 — Jobs account lifecycle fence

Date: 2026-07-21 · Status: accepted · Relates: Jobs audit A04, ADR 0019

## Context

Jobs audit phase A04 prevents a still-valid stateless JWT from recreating
user-owned Jobs data after account deletion. The invariant requires one
counted file, `shared/services/jobsAccountFence.ts`, which owns the active-
account predicate, the typed fail-closed errors, and the Mongo transaction
fence used by every user-owned Jobs writer.

The service is intentionally shared infrastructure. It is consumed by Jobs
routes and services, the Jobs-created interview-session seam, and shared usage
buffer/tracking code. Moving it into `modules/jobs` would make shared services
depend on a feature module. Folding it into account deletion, usage buffering,
or the User model would hide a security boundary inside an unrelated owner and
would create either circular dependencies or persistence/service coupling.

Main already has 152 counted shared files: A03's cross-layer Jobs contract used
the single headroom slot reserved by ADR 0019. A04 raises the actual count to
153. Shared LOC remains well below the 25,000-line budget, and the paired test
does not count because `countFiles()` excludes `__tests__/`.

## Decision

Raise `shared.maxFiles` from 152 to 154: one slot for the account-lifecycle
transaction fence and one slot of headroom. The LOC budget is unchanged.

Keep the lifecycle API in its own file so the deletion/write serialization
contract remains explicit, independently testable, and free of feature-module
or storage-adapter dependencies.

## Consequences

- CI accepts the one intentional cross-module security service.
- Shared retains only one file of headroom; the next counted addition must
  reopen the architectural budget discussion.
- No runtime behavior, dependency direction, or transaction semantics change.
- Removing A04 must also remove the fence and lower the budget in the same PR.
