# ADR 0031 — IPG Hire Phase 3 human-round delivery budgets

Date: 2026-08-13
Status: accepted
Supersedes: the Phase 2 Hire sizing envelope in ADR 0030

## Context

Phase 3 adds human interview rounds without expanding the AI interview engine
or the B2C product. A human round is evidence logged by Hire around a call that
happens elsewhere; it therefore cannot share the engine-only `HireRound`
collection and its runtime-session, consent, result-ingestion, and revocation
semantics.

The bounded Phase 3 control-plane boundary contains four distinct durable
records and the services that make them safe to recover:

- `HireHumanRound` records the immutable workspace/application/job/candidate
  coordinates and the member's minimum-disclosure interview brief;
- `HireInterviewKit` is a hash-only, revocable, expiring possession capability
  for one guest interviewer;
- `HireHumanScorecard` fixes the four reviewer dimensions, recommendation, and
  an unambiguous member-or-kit reviewer snapshot;
- `HireHumanKitDelivery` holds exactly one encrypted initial capability
  envelope and one encrypted reminder envelope, with leases and provider
  recovery state.

Those records also need independently testable lifecycle paths. Job closure,
terminal application moves, workspace deletion/purge, and candidate privacy or
retention work must revoke the public capability, cancel recoverable egress,
and remove or redact human evidence without ever adding a human-round id to
the AI runtime path. Combining that behavior into AI round or generic email
models would erase the boundary that makes it auditable.

At this decision, `modules/hire` measures **82 counted implementation files /
approximately 22.7k counted LOC**. The Phase 2 envelope of 80 files / 22,000 LOC is already
exceeded by the coherent Phase 3 foundation, before treating the remaining
headroom as a reason to collapse model, delivery, and lifecycle seams.

## Decision

Raise only `modules/hire` from **22,000 LOC / 80 files** to **25,000 LOC / 90
files**.

This leaves approximately 2.3k LOC and eight files of headroom at the measured
implementation. It is not capacity for Phase 4 aggregation, share packets,
PDFs, or reports. A future increase must first consider extracting a coherent
boundary such as decision aggregation/report generation rather than merging it
into human-round delivery.

## Consequences

- CI continues to enforce a tight module tripwire while preserving separately
  reviewable kit capability, delivery recovery, scorecard, and lifecycle code.
- The existing AI `HireRound`, `modules/interview`, `app/api/interviews`, B2C
  persistence, and shared database-model budgets remain unchanged.
- Hire retains no B2C reviewer identity dependency: HR members use
  `HireWorkspaceMember` snapshots and external interviewers are scoped only by
  their interview-kit capability.
