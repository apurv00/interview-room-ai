# ADR 0048: Scalable Hire candidate-workspace read boundary

- Status: Accepted
- Date: 2026-08-25

## Context

The job page previously rendered candidate and workflow detail together. That
shape cannot truthfully support 500–1,000 applications: it has no server-side
filter authority, stable traversal, complete counts, or immutable definition of
"all matching" for downstream actions. The existing `hire-operations` budget
covered only fixed workspace aggregates and was already at its file cap.

## Decision

Keep the company-scale candidate list and job overview in the read-only
`modules/hire-operations` boundary. It owns:

- workspace/job/privacy-scoped aggregate projections;
- validated search, saved-view predicates, filters, sorts, and an authenticated
  opaque keyset cursor with a frozen traversal timestamp;
- complete stage/JD/saved-view counts, global fresh-score rank, and narrow
  human/AI summaries without raw evidence;
- short-lived immutable selection snapshots, capped at 5,000 application/stage
  coordinates and scoped to the requesting workspace member; and
- a transaction-aware snapshot accessor for separately bounded command modules.

Bulk mutation execution remains in `modules/hire-candidate-actions`; the read
boundary does not change stages, decide offers, or send candidate messages.

Screening uses the same company-scale discipline. The server retains the full
ranked cohort only while rebuilding its deterministic fingerprint, but the
member transport exposes scalar counts and at most 50 rows for selected,
evaluated, score-attention, or knockout review. Candidate identity is joined
only for that page (plus the single cut-line candidate when needed). Explicit
exception lookup is a separate 20-row, non-terminal, privacy-aware identity
search. Gate history, invitation waves, and each recipient ledger are separate
tenant-scoped keyset pages; advancing any one replaces the visible page rather
than accumulating hundreds of rows in the browser.

The existing `modules/hire` core retains the transaction invariants it already
owns. A snapshot-driven Screening preview is resolved again inside the current
confirmation transaction, where job status, expected stage, privacy state, and
live invitation availability are revalidated. Bulk stage execution opts into
the existing candidate privacy write fence rather than reimplementing that
authority in the new command module. The three Decision inbox keyset indexes
are preparer-only: their authoritative runtime schemas deliberately do not
declare them because runtime `autoIndex` is not a rollout authority. Workspace
purge calls the two new transaction-aware deletion seams before
candidate/application parents so selection and bulk-operation authority records
cannot be orphaned.
These are narrow adapters, purge calls, and index declarations, not a new
candidate-list or bulk-workflow surface in `modules/hire`.

The explicit candidate-workspace index preparer owns 19 exact indexes. Five are
derived additions from the query matrix: job snapshot scans, candidate history
joins, pending intake-state joins, job delivery counts, and batch-scoped
recipient-ledger keyset pages. It also
plans/checks/applies both snapshot indexes, all nine bulk-action indexes, and
three decision-inbox keyset indexes.
Plan mode is disconnected, check mode is read-only, and apply creates only
missing exact indexes after incompatible-name/key and unique-data preflights.
It never drops or synchronizes indexes.

The remaining joins use already-declared exact indexes: candidate and job
identity use `_id`; privacy uses `{workspaceId,candidateId,live}`; synthetic
test-drive exclusion uses `{workspaceId,applicationId,excludeFromAggregates}`;
human rounds, scorecards, and AI rounds use their workspace/application
indexes; and the latest gate/batch reads use their workspace/job/time indexes.
Name, attention, stage, score, rank, and activity ordering are derived after
privacy-safe joins, so they intentionally sort only the indexed, bounded job
cohort rather than creating misleading indexes over non-persisted projections.
Candidate cursor pages return rows and `limit + 1` page state only; filtered
counts and funnel/rank context use a separate endpoint, so advancing a cursor
does not recompute them. Each fresh row still carries the full privacy-safe job
denominator produced in the same rank window, keeping “Rank x of y” truthful
even if the count summary is loading independently.

Cursor v2 authenticates two narrow epochs in addition to the normalized query,
snapshot time, sort coordinate, and ObjectId tie-breaker:

- `HireJob.candidateReadVersion` changes for job-local semantic mutations to
  rows already visible in the frozen cohort. Pure intake/task churn and new
  applications after the snapshot do not change it; those arrivals remain
  outside the traversal and are reported by the lightweight freshness read.
- `HireWorkspace.privacyAggregateFenceVersion` is also the candidate-directory
  and privacy epoch. Candidate identity, resume/source/history projection, and
  privacy changes that can affect job membership, filtering, or ordering change
  it. Unrelated member, email, selection, and administrative writes do not.

The service compares both epochs before and after every page aggregation,
including page one. A semantic mutation racing either side returns controlled
HTTP 409 `JOB_CANDIDATES_CURSOR_STALE`; it never mints a cursor over mixed
revisions. Technical dispatch mutexes and audit-only receipt appends do not
change list activity or either candidate-read epoch. Pending-privacy visibility
is evaluated at the frozen cursor timestamp, preventing natural verification
expiry from adding a row halfway through traversal. Freshness uses current
privacy visibility and only returns whether a post-snapshot matching row exists.

Mongo global JD ranking uses a single-score `$rank` window because MongoDB does
not permit `$documentNumber` with the multi-field sort needed for deterministic
ties. Equal fresh scores therefore share a truthful competition rank; the later
keyset sort uses rank plus `_id` for deterministic traversal. AI activity is the
maximum semantic round timestamp (invitation/creation, consent, preparation,
result link/completion, or revocation), never generic `updatedAt` churn from
technical reservations or handoffs.

Selection resolution and persistence run inside the active workspace write
transaction so privacy deletion cannot race an unfenced snapshot insert.
All-matching descriptions enumerate deterministic normalized non-PII filter and
sort codes, record only `search applied` when a query exists, never persist the
query text, and remain bounded to 500 characters. A transaction-required
subject-purge seam invalidates an entire snapshot containing any erased
application ID; privacy deletion overrides the snapshot's normal immutability.

## Budget

Raise `modules/hire-operations` from 3,000 LOC / 12 production files to 5,700
LOC / 14 files. The candidate reader freeze initially measured 5,597 LOC / 13
files. The final Screening scale review adds the bounded gate-batch keyset read
and the optional non-terminal scope on the existing identity-only search,
bringing the checkpoint to approximately 5,623 LOC without another production
file. The remaining file slot and roughly 77 LOC are tripwire-only headroom,
not a general reporting or command allowance. Further material growth should
split the candidate-workspace projection into its own read module instead of
raising this cap again.

Raise `modules/hire` from 28,100 LOC / 92 production files to 28,400 LOC / 92
files. At the candidate reader checkpoint, the integrated branch measured
28,265 LOC / 92 files. The final Screening scale review adds conservative
retained-source-hash validation, controlled stale-preview conflicts, a
single-command privacy fence, and bounded history metadata, bringing the
checkpoint to approximately 28,316 LOC with no new production file. The
remaining roughly 84 LOC are tripwire-only headroom. The intended delta remains
limited to the Screening snapshot consumer, privacy-fenced bulk-stage adapter,
workspace-purge seams, and narrow operations-boundary exports; the three
Decision indexes are deliberately preparer-only. Further candidate-workspace
growth must stay in `hire-operations` or `hire-candidate-actions`, or extract a
separately budgeted boundary; it must not raise the core cap again.

## Consequences

- List traversal remains stable as new candidates arrive, and callers receive
  an explicit current-privacy refresh signal without replacing the page.
- Global rank is computed before page and saved-view filters, never relative to
  the returned page; tied scores share competition rank.
- Selection consumers revalidate tenancy, job, member, expiry, and current
  application state while retaining the immutable expected-stage coordinate.
- Screening review remains directly navigable at 5,000 evaluated candidates
  without transmitting or mounting the full ranked cohort, historical waves,
  or delivery ledger.
- The core module stays at its 92-file cap and gains no candidate list, cursor,
  bulk-operation orchestration, or new communication authority.
- Mongo rollout requires the explicit candidate-workspace index apply step;
  application runtime never relies on `autoIndex`.
