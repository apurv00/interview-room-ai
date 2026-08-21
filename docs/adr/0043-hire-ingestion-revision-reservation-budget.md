# ADR 0043 — Hire ingestion revision reservation boundary

Date: 2026-08-21

Status: accepted

## Context

Hire result and recruiter-only multimodal-analysis ingestion used to copy
runtime media before checking whether an event was duplicate, stale, or a
same-revision conflict. Delayed and concurrent deliveries could therefore
stage control-plane assets even when their database outcome was later rejected.

Both flows require the same durable invariant: one exact workspace,
application, round, runtime session, attempt, revision, event id, and canonical
digest must be reserved before any R2 or candidate-asset mutation. A crashed
exact owner must be reclaimable without allowing another attempt, event, or
digest to take over its in-flight revision.

The shared authority adds one focused service to `modules/hire`, optional
reservation heads to the existing round aggregate, and durable staging-row
resume for an interrupted media copy. Integrating the P0 opaque-object and
lifecycle protocol plus immutable result/analysis retry snapshots, when
stacked with the deployment and handoff boundaries, brings the integrated
module to 27,957 LOC / 92 files. The shared attempt, deployment-identity, and
cross-surface contracts bring `shared` to 26,365 LOC / 182 files.

## Decision

Keep one `ingestionRevisionReservationService` in `modules/hire` and expose its
narrow primitives through the existing sanctioned Hire boundary. Result and
multimodal-analysis heads remain independent, while each head atomically
records the exact runtime session, attempt, revision, event id, digest, owner
token, and lease state. The ingestion event is written in the same Mongo
transaction as the head reservation; final event and round state are committed
only by that owner token. Its terminal outcome distinguishes `processed` from
`stale`, so a lost acknowledgement cannot turn a stale retry into a duplicate.

Raise the `modules/hire` guard from 26,000 LOC / 91 files to 28,100 LOC / 92
files. At the measured 27,957 LOC / 92 files this leaves 143 LOC and no spare
production-file slot. Raise `shared` from 26,200 LOC / 180 files to 26,400 LOC
/ 182 files, leaving 35 LOC and no spare production-file slot. The additional
body is the reviewed P0 storage protocol, checkpoint recovery, lifecycle
activation fencing, complete pre-send snapshots, deployment identity, and
versioned wire state rather than duplicated result/analysis ordering logic.

Attempt-aware unique indexes and a media checkpoint index are a mandatory
drained migration. Existing analysis ledger rows are backfilled through their
immutable analysis and interview-attempt coordinates; abandoned legacy
`received` rows are removed during the closed ingress window so their runtime
outboxes can retry. Existing processed rows are backfilled with the historical
`processed` terminal outcome. Existing rounds need no head backfill.

## Consequences

- Duplicate, stale, conflicting, and concurrently blocked deliveries return
  before either ingestion flow invokes the media adapter.
- Exact failures release their owner lease; abrupt process loss is recoverable
  after the bounded lease while active retries remain serialized. Each
  checkpoint generation uses a random asset id and opaque nonce with
  `If-None-Match: *`. A retry GET-verifies and adopts an exact object written
  before a crash. Purged, purge-failed, tombstoned, or mismatched generations
  are quarantined and followed by a fresh id/nonce, preventing deterministic
  destination poisoning.
- Media activation reclaims the workspace, candidate privacy fence, and job
  retention lock in one transaction. Reuse requires an active, ready,
  unexpired exact asset. A copied landmark that loses its final consent or
  lifecycle check is removed from the active set in the terminal transaction.
- Production ingress is fail-closed unless protocol v2 is required, the sender
  presents the v2 header, and the recorded six-minute disable/drain window has
  elapsed.
- Runtime source keys are no longer retained in result event rows; the
  canonical digest remains the idempotency authority.
- A future Hire core feature that needs another production file must extract a
  boundary or explicitly revisit this cap.

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| Check the latest revision immediately before the final transaction | Media and asset mutations have already happened by then, which is the race being closed. |
| Keep separate ordering implementations in result and multimodal modules | It duplicates a concurrency protocol and makes their failure semantics drift. |
| Lazy index adoption | Old unique indexes omit attempt and would still reject a valid later attempt; an explicit drained migration is required. |
| Collapse the new service into an unrelated existing file | It would hide a security-sensitive state machine and make focused concurrency review harder. |
