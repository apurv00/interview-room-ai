# ADR 0022: Jobs maxLOC 14,000→16,000 — source control plane

Date: 2026-07-22 · Status: accepted · Relates: Jobs audit A08, ADR 0018/0019

## Context

Jobs audit phase A08 replaces raw database and break-glass source operations
with a bounded control plane. The added Jobs-owned code covers the reviewed
source catalog, operational commands, dual-revision authority, atomic Redis
request ceilings, cold validation, worker completion evidence, CMS contracts,
and adversarial tests. The legal revoke/restore protocol remains separate.

The module now exceeds its original 14,000-line readiness tripwire. Moving
these rules into `shared` would hide Jobs policy inside generic infrastructure;
removing the tests or operator contracts would weaken the rollout gate.

## Decision

Raise `modules/jobs.maxLOC` from 14,000 to 16,000. Keep `maxFiles` at 70. The
new ceiling leaves limited maintenance headroom without turning the budget into
an open-ended allowance.

## Consequences

- CI accepts the cohesive A08 control-plane implementation and its tests.
- Provider identity, quota, validation, and lifecycle policy stay owned by the
  Jobs module.
- The next material Jobs expansion must justify another budget decision or
  remove/split existing complexity first.
- The unchanged file-count cap continues to discourage unnecessary layers.
