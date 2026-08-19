# ADR 0039 — Hire-native supplemental observation boundary

Date: 2026-08-17

Status: accepted

## Context

Hire interviews are real assessments, not the consumer practice flow. They
need Indian-English runtime speech and, with explicit v3 consent, a narrowly
defined supplemental observation path. Reusing the consumer multimodal
analysis pipeline would collect raw landmark artifacts, create behavioural
scores, and route data through consumer result and feedback contracts.

The existing `modules/hire` control plane is at its 90-file cap. Its remaining
responsibilities in this feature are necessarily root-lifecycle integrations:
immutable consent receipt validation, verified deletion, candidate retention,
workspace purge, and the job-close retention scheduler. Moving those into a
second writer would weaken the existing transaction and privacy fences.

## Decision

Create `modules/hire-multimodal` with an initial budget of **5,000 counted LOC
/ 20 counted files**. It owns only:

- the recruiter-only derived-observation and idempotency models;
- a versioned, signed runtime-to-control bridge;
- a durable job-close runtime-purge obligation and its retry policy; and
- neutral report validation and retention operations.

The runtime owns its separate derived-only outbox and retention tombstone.
Neither boundary stores raw camera samples, landmarks, blendshapes, audio,
transcripts, scoring, recommendations, stage transitions, or export payloads.

Raise the existing `modules/hire` LOC tripwire from **25,000 to 26,000** and
its file tripwire from **90 to 91**. The one-file allowance is exclusively for
the two-export `multimodalBoundary` facade, which lets the isolated multimodal
module consume the consent version and `HireRound` without loading the broad
route-facing Hire barrel. The measured post-change core is about 25.5k LOC;
the narrow headroom is reserved for unavoidable lifecycle adapters and that
single boundary seam only.

## Consequences

- Hire observations remain supplemental and recruiter-visible only; they are
  never part of assessment results, rankings, decisions, reports, exports, or
  share packets.
- A v3 consent receipt is required for collection. Existing v2 attempts may
  finish, but cannot activate this path.
- Six calendar months after job close, a signed runtime purge writes a durable
  per-round fence before both planes delete their derived data. Privacy and
  workspace deletion continue to win over the bridge.
- New use cases such as biometric scoring, raw-media retention, candidate
  self-service access, or exported observations require a separate ADR and
  must not be added to this boundary.
