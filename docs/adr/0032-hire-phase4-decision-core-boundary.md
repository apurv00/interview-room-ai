# ADR 0032 — IPG Hire Phase 4 decision-core boundary

Date: 2026-08-14
Status: accepted
Supersedes: none

## Context

Phase 3 intentionally kept human interview evidence as individual submitted
scorecards. Its bounded `modules/hire` envelope is not capacity for the Phase
4 work that reads evidence together, creates limited share capabilities, and
records a stakeholder's one-time verdict. Folding that work into the pipeline
or human-kit delivery services would make a presentation/read concern capable
of changing stages or reusing the AI interview engine's persistence.

The Phase 4 decision core has four distinct responsibilities:

- a read-only aggregate of submitted human scorecards, separated by member and
  interview-kit reviewer source, with per-dimension distributions rather than
  a blended recommendation;
- a separate tally of external share-packet verdicts, which are not scorecards
  and cannot carry rubric dimensions or human-round reviewer authority;
- a `HireSharePacket` possession capability, stored only as a SHA-256 hash of
  a random 32-byte secret, with immutable Hire coordinates, expiry/revocation,
  and an immutable allowlisted snapshot;
- a `HireExternalVerdict` record with exactly one immutable recommendation and
  optional bounded comment per packet.

It also supplies two read-only decision DTOs: an action inbox derived from
pending human scorecards, terminal kit-delivery failures, and newly submitted
external verdicts; and a deliberate same-job comparison of two or three
applications. Neither DTO receives a candidate rank, stage, note, raw
evidence/media, contact information, or persistence/audit identifier.

The public packet must never widen when internal data grows. In particular its
snapshot excludes candidate contact details and raw resumes, raw AI output,
transcripts/media/evidence references, application/job audit data, ranks,
stages, and decision/close notes. AI assessment summaries remain visibly
separate from human and external evidence. No decision-core method writes an
application or calculates an automatic stage move.

## Decision

Create a top-level `modules/hire-decisions` boundary with the `@hire-decisions`
alias and an initial CI budget of **5,000 counted LOC / 20 counted files**.
The module may read models from the existing isolated Hire control database
through its small boundary adapter, but it does not import or write B2C users,
the interview runtime, `modules/interview`, or application pipeline/lifecycle
services.

The server-side aggregate exposes a typed safe DTO, and the packet snapshot is
constructed only by a deep, section-gated allowlist. Future routes, compare
screens, PDF/report work, and lifecycle hooks may consume this contract but
must not extend the public payload by spreading persistence documents.
The inbox and compare readers are likewise allowlisted and read-only; compare
preserves caller order instead of deriving an ordering from evidence.

## Consequences

- Phase 3's `modules/hire` tripwire remains intact; its human-round records
  remain the source of truth for submitted scorecards.
- Human recommendations, external verdicts, and AI assessment summaries are
  deliberately separate. A future UI may display them together, but cannot
  mistake the aggregate for a composite score or stage decision.
- Packet lifecycle writers must use the packet's immutable workspace,
  application, job, and candidate coordinates for transaction fences. This
  ADR adds no lifecycle action itself.
- If Phase 4 grows beyond this focused decision core, a follow-up ADR must
  account for the additional package shape rather than treating the budget as
  a general reporting allowance.
