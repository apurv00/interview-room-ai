# ADR 0023: Jobs maxLOC 16,000→17,000 — broken-link governance

Date: 2026-07-22 · Status: accepted · Relates: Jobs audit A09, ADR 0022

## Context

Jobs audit phase A09 replaces a permanent, single-user broken-link demotion
with bounded transactional governance. The Jobs-owned code records current
Apply attempts, binds reports to URL generations and incidents, requires a
three-user quorum for soft ordering, arbitrates every link with the pinned
machine checker, and can recover postings closed during temporary outages.

The complete phase exceeds its 16,000-line tripwire while remaining below
16,500 lines. Moving the governance helper into `shared` would conceal Jobs
product and abuse policy in generic infrastructure, while removing the
authority, same-link recovery, user-warning, or telemetry paths would leave
the original audit finding only partially resolved.

## Decision

Raise `modules/jobs.maxLOC` from 16,000 to 17,000. Keep `maxFiles` at 70. The
increase covers this cohesive phase with limited maintenance headroom; it is
not a blanket allowance for later audit work.

## Consequences

- CI accepts A09's report authority, machine arbitration, and recovery logic.
- Broken-link policy remains inside the Jobs domain that owns it.
- Later material growth must remove/split complexity or justify a new decision.
- The unchanged file cap still discourages unnecessary layers.
