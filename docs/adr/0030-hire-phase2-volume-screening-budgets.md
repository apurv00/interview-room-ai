# ADR 0030 — IPG Hire Phase 2 volume and screening budgets

Date: 2026-08-13
Status: accepted
Supersedes: the Phase 1 Hire sizing envelope in ADR 0029

## Context

Phase 2 adds a durable control-plane layer to IPG Hire rather than expanding
the interview engine or B2C product. Its responsibilities are intentionally
separate because they have different security, recovery, and privacy
properties:

- asynchronous resume-intake tasks retain raw applicant material only while a
  workspace-scoped worker parses, scores, deduplicates, or requests identity;
- screening gates freeze a deterministic, reviewable ranking and human
  exceptions against an immutable job requirement version;
- invitation batches and batch items provide durable scheduling, retries,
  waterfall selection, and a one-application reservation;
- privacy deletion, retention, and workspace hard purge remove or redact each
  new artifact using exact workspace and candidate coordinates.

At this decision, `modules/hire` measures 74 counted implementation files and
19,795 counted lines. Combining these concerns into existing Phase 1 services
would make the old budget pass only by hiding queue payload handling,
candidate-fence transactions, and invitation lifecycle behavior inside broad
files. That would weaken targeted review and recovery testing.

The Phase 2 architecture continues to preserve the hard boundaries: no code
under `modules/interview`, `app/api/interviews`, or `shared/db/models` changes,
and Hire candidate identity is never resolved against B2C users.

## Decision

Raise only `modules/hire` from **14,000 LOC / 66 files** to **22,000 LOC / 80
files**.

This leaves roughly 2,205 lines and six files of headroom at the measured
Phase 2 implementation. It is a tripwire, not prepaid capacity: a later
increase should first consider extracting a coherent operational boundary,
such as intake processing or reporting, rather than coalescing or endlessly
raising the Hire module budget.

## Consequences

- CI again enforces a tight bound while accepting the Phase 2 service seams.
- The implementation can keep independently testable models and services for
  queue payload cleanup, scoring/gate decisions, batch delivery, and privacy.
- No budget changes are made for the interview engine, B2C persistence, or
  shared module; the established protected-boundary checks remain required.
