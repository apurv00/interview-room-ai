# ADR 0033 — IPG Hire Phase 5 operations read-model boundary

Date: 2026-08-14
Status: accepted
Supersedes: none

## Context

Phase 4 makes evidence and individual decisions usable. Phase 5 needs a
member-facing operational picture without making a dashboard route capable of
moving candidates, generating reports, exporting data, or reading the broad
Hire command/validator barrel. A single page-level composition over the
pipeline also risks an N+1 query per job and accidentally returning candidate
contact information, raw AI output, decision notes, or reviewer prose.

## Decision

Create `modules/hire-operations` with the `@hire-operations` alias and an
initial CI budget of **3,000 counted LOC / 12 counted files**. Its only Hire
dependency is `@hire-operations-boundary`, a direct facade over the isolated
Hire control database, membership gate, and read-model collections. It never
imports `@hire`, `modules/hire/index.ts`, or Hire validators.

The module issues fixed workspace-scoped batch reads. It filters candidate IDs
to non-anonymized candidates before querying applications, rounds, deliveries,
verdicts, results, and candidate-associated audit sources; it projects only
allowlisted aggregation fields; and it returns explicit plain DTOs. It performs
no pipeline/lifecycle writes and no report, CSV, digest, status-page, or
onboarding work.

### Stable Phase 5A HTTP contract

All routes require a current Hire member, derive `workspaceId` only from that
membership, are `force-dynamic`, and return `Cache-Control: private, no-store`.

| Method and route                             | Response                                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/workspace/overview`                | `{ asOf, kpis: { openJobs, candidatesAwaitingDecision, scorecardCompletion, medianTimeToCloseDays }, actionInbox: { items } }` |
| `GET /api/workspace/jobs/health`             | `{ asOf, jobs: [{ jobId, title, status, daysOpen, funnel, attention }] }` sorted by attention, then age                        |
| `GET /api/workspace/jobs/:jobId/performance` | `{ asOf, job, funnel: { current, conversions }, humanScorecards, scoreDistribution, timeToCloseDays }`                         |
| `GET /api/workspace/audit?cursor=&limit=`    | `{ items: [{ kind, occurredAt, actor: { kind, name }, target: { kind, id } }], nextCursor }` in stable descending order        |

`scoreDistribution.buckets` is emitted only when there are at least ten valid
latest AI scores. At fewer than ten scores, **only** the member-authorized
per-job performance payload emits `scoreDistribution.fallbackCandidates`,
capped at nine entries, each exactly `{ applicationId, candidateName, score,
rank }`. The fallback is derived from applications and candidates scoped to
that exact workspace job; `rank` is local to that returned list. It is omitted
when the chart becomes eligible and is never returned from overview, health,
reports, exports, public, or status routes.

### Read-only audit projection

The audit route has no generic event writer. It derives a finite allowlist of
safe events from `HireApplication.events`, `HireJob.events`, and the safe
lifecycle metadata already owned by report exports, candidate status links,
and digest outbox receipts.
The source projection reads only event kind/time/member-name snapshot and the
opaque application, job, report, or status-link target ID. The internal event
coordinate exists only inside the opaque cursor; it is not a response field.

Application and status-link events are omitted when their candidate is
anonymized or has a live privacy request, and status-link/report rows marked
privacy-redacted are omitted.
The DTO never carries candidate identity/contact data, notes, decision text,
resume/JD, evidence/transcript/media, score, capability/hash, raw snapshot,
provider/error/object-key data, delivery recipient, or a B2C actor pointer.
An actor is either an immutable bounded member-name snapshot or fixed
`{ kind: "system", name: "System" }`.

Digest audit receipts are limited to the durable queued, sent, and cancelled
timestamps and use the system actor. The projection never reads recipient
name/email, aggregate payload, provider message ID, claim/lease state, or
failure code; a digest failure has no immutable receipt timestamp and is not
represented until one exists.

Except for the deliberate small-sample fallback and the deliberate audit actor
snapshot, no response includes candidate identity/contact data, a raw score,
candidate rank, resume/JD, transcript/media/evidence, reviewer comment,
application note, delivery recipient, provider error, or capability.

## Consequences

- A UI can render the KPI strip, grouped operation inbox, job-health table,
  and per-job performance visualizations from stable narrow payloads.
- Candidate-specific decisions remain in the Phase 4 decision boundary. Below
  the chart floor, members receive a capped, exact-job ranked list instead of
  an aggregate visualization that could imply a false statistic.
- Future report UI, daily digests, candidate-status UI, onboarding, or other
  event categories require their own bounded additions rather than being
  folded into this read model.
