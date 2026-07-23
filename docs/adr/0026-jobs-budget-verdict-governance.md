# ADR 0026: Jobs verdict-governance budget

Date: 2026-07-23 · Status: accepted · Relates: Jobs audit A09, ADRs 0023/0025

## Context

A09 completes the verdict control plane that the existing scoring and link
workers lacked: independent collection and fraud-enforcement switches, a
parked ranking switch, complete revision history with rollback, and permanent
evidence/review records for serving-impacting automatic decisions.

The implementation adds two cohesive Jobs services, two shared persistence
models, and one pure client-safe limits contract shared by the CMS, services,
and models. The shared models follow the repository convention and need
distinct collections/index lifecycles. The Jobs code retains Mongo transaction
and source-revision fences so a lifecycle mutation cannot commit without its
decision evidence. Review paging is a concrete bounded cursor; generic policy
frameworks, automatic historical replay, and full hard-drop payload retention
were deliberately excluded before accepting growth.

Post-change actual size is about 21.3k LOC / 76 counted files in `modules/jobs`
and 160 counted files in `shared`.

## Decision

- Raise `modules/jobs` from 20k/75 to 22k/77. This leaves roughly five percent
  LOC headroom and one file, not an open-ended platform budget.
- Raise `shared` from 157 to 160 files: two required models plus the pure limits
  contract that prevents server/client validation drift. No file-count
  headroom remains; its 25k LOC ceiling remains unchanged.
- Keep review evidence bounded and URL-free; a hard drop stores only identity
  fields and a 4,000-character description excerpt, not a provider payload.
- Treat collection as a prerequisite for enforcement. An enforce-on,
  collection-off configuration is invalid because no serving mutation may
  occur without a permanent decision record.
- Do not automatically replay historical shadow scores when enforcement is
  enabled. Enforcement applies to decisions made from a newly evaluated or
  changed input after activation. Any historical reconciliation requires its
  own reviewed, bounded migration with explicit serving-impact evidence.
- Bound one decision's durable source-revision snapshot to 128 unique source
  lineages and make the deployed-corpus preflight an activation gate. Raising
  the bound requires a reviewed storage and transaction-size decision.

## Consequences

- CI accepts the minimum A09 governance boundary and continues to flag the
  next material expansion.
- A future policy DSL, ranking engine, or generic moderation workflow requires
  its own product decision; it is not authorized by this budget.
- Turning enforcement on does not silently convert previously collected
  shadow scores into closures or restrictions. This avoids an unbounded,
  unreviewed serving-state migration during a config change.
- Removing this governance boundary must remove its models/services and lower
  both budgets in the same change.
