# ADR 0024: Jobs budget for intent-driven discovery

Date: 2026-07-22 · Status: accepted · Relates: Jobs audit A12, ADR 0023

## Context

Jobs audit phase A12 replaces a bounded in-memory, offset-paginated feed with
Mongo-backed intent discovery. The Jobs-owned code adds query-bound cursor
traversal, hard factual filters, non-excluding location and experience
preferences, private resume personalization, stale-request protection, and a
read-only quality report for supply, freshness, employer concentration,
provider efficiency, and human-labeled remote precision.

The phase adds four counted files and 1,279 net counted lines, taking
`modules/jobs` to 72 files and 17,881 lines. Combining the discovery engine and
quality report would create a thousand-line mixed-responsibility service;
moving either into `shared` or `scripts` would hide Jobs product policy from
its owning module. Removing cursor integrity, the private/public boundary, or
quality evidence would leave the audit finding only partially resolved.

## Decision

Raise `modules/jobs.maxLOC` from 17,000 to 19,000 and `maxFiles` from 70 to 73.
The new limits leave one file and about 1,100 lines of maintenance headroom.
They cover this cohesive phase without excluding discovery or reporting code
from the module-size calculation.

## Consequences

- CI accepts the complete A12 discovery contract and its operational evidence.
- Discovery policy and quality definitions remain owned by the Jobs module.
- The file cap continues to discourage unnecessary layering.
- Later material growth must simplify or extract a coherent subsystem, or
  justify another explicit architecture decision.
