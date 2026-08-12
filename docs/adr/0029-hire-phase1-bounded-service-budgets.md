# ADR 0029 — IPG Hire Phase 1 bounded-service size budgets

Date: 2026-08-10
Status: accepted
Supersedes: the Phase 1 sizing estimate in ADR 0028

## Context

Phase 1 of IPG Hire is a production spine, not only the initially estimated
workspace/job CRUD slice. Its `modules/hire` control plane owns workspace and
member access, candidate/application/round state, guest consent, identity
media, evidence, lifecycle deletion, durable email delivery, and the internal
handoff/result boundary to an isolated interview runtime. The completed spine
contains 62 counted files and 12,916 counted lines.

Those responsibilities are deliberately separated by persistence model,
security boundary, and lifecycle service. In particular:

- the interview engine remains unchanged and is reached only through explicit
  handoff/result contracts keyed by workspace, application, and round;
- Hire candidates remain module-local identities and are never resolved
  against B2C users;
- the Hire control and runtime databases are fenced from the B2C database; and
- consent, media retention, deletion, tenant-scoped writes, evidence, and
  delivery each remain independently testable and auditable.

The cross-surface contracts that both sides must understand belong in
`shared/`: runtime bridge and write-fence contracts, internal-service auth,
database-name fencing, host redirects, account-deletion propagation, and
deployment-readiness checks. They take `shared` to 175 counted files and
25,276 counted lines. They do not add Hire records to B2C tables or move
interview-engine internals into Hire.

Collapsing these models and services into fewer, larger files would make the
file counter green without reducing production complexity. It would instead
hide tenant, identity, privacy, and runtime seams inside broad units, weaken
review ownership, and make targeted tests and later extraction harder. The
bounded-service split is therefore preferable to a cosmetic consolidation.

## Decision

Raise only the two budgets consumed by the Phase 1 architecture:

- `modules/hire`: 10,000 to **14,000 LOC** and 45 to **66 files**. This leaves
  1,084 lines and four files above the measured Phase 1 spine.
- `shared`: 25,000 to **26,000 LOC** and 167 to **180 files**. This leaves 724
  lines and five files above the measured cross-surface kernel.

No budget changes are made for the interview engine, B2C, or any other module.
Future growth beyond these limits requires another architecture decision and
should prefer extracting a coherent service boundary over raising the limits.

## Consequences

- CI accepts the intentional Phase 1 service boundaries while retaining tight
  LOC and file-count tripwires.
- The unchanged engine and B2C persistence boundaries stay independently
  reviewable; this decision changes no application behavior.
- Near-term fixes have modest headroom, but later product phases are not
  prepaid by this budget and must justify their own structure.
