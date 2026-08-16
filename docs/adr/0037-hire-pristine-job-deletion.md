# ADR 0037 — Guarded deletion of pristine Hire jobs

Date: 2026-08-16

Status: accepted

## Context

Hire jobs previously supported only lifecycle transitions: open, on hold, and
closed. A recruiter who created an unused requisition had no way to remove it,
but treating every job deletion as a cascade would conflict with the existing
candidate, interview, report, media, runtime, and retention boundaries.

`modules/hire` is at its deliberate 90-file cap. The job-status command and
workspace hard-purge graph are high-impact lifecycle primitives and must not
absorb an ordinary UI delete action.

## Decision

Create `modules/hire-job-deletion` with an initial budget of **3,000 counted
LOC / 12 counted files**.

- Only a workspace admin may delete a job.
- The command requires an exact current-title confirmation and explicit
  acknowledgement at the HTTP boundary.
- The delete runs inside the existing active-workspace write transaction.
- It may remove only the job root and its job-owned immutable requirement
  versions.
- Every direct job-scoped child is a blocker: intake, applications, screening,
  interview evidence, egress, public capabilities, reports, export cleanup
  tombstones, media, and onboarding test-drive records.
- Closed jobs are retained for decision and retention history. Jobs with any
  activity must use the explicit close lifecycle instead of delete.

## Consequences

- This is permanent deletion of an unused requisition, not archival and not a
  candidate-data purge.
- A later request for deletion/audit retention of populated jobs requires a
  separate durable lifecycle design; it must not be added as a cascade branch
  to this command.
- No new collection, index, background worker, external object deletion, or
  runtime revocation is introduced by this decision.
