# ADR 0034 — IPG Hire Phase 5 report-export boundary

Date: 2026-08-14
Status: accepted
Supersedes: none

## Context

Phase 5 adds leadership-facing pipeline reports, close-out reports, and later
portable data exports. These are not an extension of the Phase 4 candidate
assessment PDF: a pipeline report can cover a whole workspace, a close-out
report is coupled to a job-close operation, and either artifact may outlive a
member request while a private renderer/storage worker runs.

Folding those concerns into `modules/hire`, the operations reader, or the
decision packet module would blur three important boundaries:

- reports must use a frozen, deep-allowlisted aggregate snapshot rather than
  live Mongoose documents or a broad operational response;
- private artifact generation, retry, expiry, and deletion need durable,
  scope-bound records and a deletion-only tombstone, not a public URL;
- reporting may show separately labelled AI, member-scorecard, kit-scorecard,
  and external-verdict evidence, but may not derive a rank, blended score, or
  automatic pipeline move.

## Decision

Create a top-level `modules/hire-reports` boundary with an initial CI budget
of **10,000 counted LOC / 30 counted files**. It owns:

- `HireReportExport` and `HireReportExportCleanup` records with immutable
  workspace/job/report coordinates, private deterministic object keys,
  bounded worker leases, explicit lifecycle states/timestamps, an immutable
  bounded Hire-member requester snapshot (never a B2C user), and retry-safe
  cleanup;
- typed, deeply allowlisted pipeline-status and job-closeout snapshots plus
  shared render components that receive only those snapshots;
- private PDF/Excel rendering and storage ports, when implemented, with
  no signed or public object URL; and
- report worker/recovery helpers that carry durable identifiers only.

The module may use the narrow Hire-control boundary for scoped model reads and
fences. It must not import the root `@hire` barrel, B2C models/users, the
interview engine/runtime, or pipeline write services. It does not itself own
member routes, Inngest registration, a workflow that closes a job, or a
general operations dashboard.

`xlsx` is a report format contract only. A renderer dependency is added only
after its deployed/runtime feasibility is explicitly checked; the initial PDF
renderer remains the independently verifiable private-artifact path.

## Consequences

- A Phase 5 report is reproducible from an immutable snapshot, not a mutable
  current view that can change while a worker is retrying.
- Candidate IDs needed for privacy lifecycle handling remain select-hidden and
  outside the rendered snapshot; contact data, resumes, raw media/transcripts,
  provider responses, internal rank, and storage keys remain excluded.
- A later source-projection audit can read the report request actor, request
  time, latest worker claim, terminal status, and terminal timestamp from the
  export record; it does not need a second generic report-write log.
- A later lifecycle owner must create a cleanup tombstone before cancellation
  or snapshot redaction, wait through the bounded worker/provider settlement
  window, and only then delete the exact deterministic object.
- If reporting grows beyond its private export and render controls, a future
  ADR must split the package rather than treating this budget as a general
  Phase 5 overflow allowance.
