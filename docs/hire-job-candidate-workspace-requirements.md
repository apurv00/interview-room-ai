# Hire job candidate workspace requirements

Status: implementation contract

Date: 2026-08-25

## Product outcome

A job with 500–1,000 applications must remain usable without loading or
rendering the full candidate pool. Job administration, candidate operations,
screening, decisions, and performance are separate tasks with stable routes.

The job workspace navigation is:

1. Overview
2. Candidates
3. Screening
4. Decisions
5. Performance

Candidate detail keeps its canonical `/workspace/applications/:applicationId`
route. List state is URL-addressable so returning to a job restores the active
view, filters, sort, and page position.

## Screen contracts

### Overview

- Returns job metadata, stage counts, attention counts, recent activity,
  acquisition-link status, and screening/delivery summaries.
- Does not fetch, serialize, or render candidate rows.
- Presents `Add candidate` as the primary action and groups department,
  duplicate, hold/reopen, close, and pristine-delete actions under
  `Manage job`.

### Candidates

- Uses server-side search, filtering, sorting, and opaque cursor pagination.
- Defaults to 50 rows and rejects limits above 100.
- Provides URL-backed saved views for all candidates, scoring attention,
  screening attention, interview attention, decision-ready candidates, and
  offers.
- Supports stage, source, applied-date, JD-score state/range, human-review
  state, AI-interview state, and workspace-history filters when the source
  data exists.
- Supports stable sorts for attention/newest, oldest, name, stage, JD match,
  global job rank, human-review state, and last activity.
- Renders a semantic desktop table and a priority-ordered mobile card view
  from the same narrow DTO.
- Keeps JD match, JD rank, AI assessment, human scorecards, and recruiter
  decision visibly separate. It never creates a blended overall score.
- Expresses rank against the full fresh scored denominator and reports stale,
  unscored, and pending counts. Rank is never calculated inside one page.
- Shows human recommendation/count disagreement rather than manufacturing an
  unowned star rating.
- Provides Add, Import, talent-pool Suggestions, candidate detail, compare,
  screening handoff, and safe row actions without preloading the workspace
  candidate pool.
- Supports a dense table and a stage-board presentation without fetching or
  mounting all job applications.
- Supports column visibility without hiding Candidate, Stage, or row actions.

### Screening

- Owns rule definition, deterministic preview, cut-line review, unknown/stale
  review, documented exceptions, scheduling, explicit confirmation, batch
  history, delivery status, and retry.
- Preserves preview fingerprint and stale-confirmation protection.
- Never rejects a candidate or changes a pipeline stage automatically.
- Can start from explicit candidate selection or a server-side selection
  snapshot without trusting a mutable client ID list.
- Never transports or mounts the complete ranked cohort. Preview pages are
  server-owned and capped at 50 rows, with direct selected, all-evaluated,
  score-attention, and known-knockout scopes; cut-line identity uses at most
  one additional read.
- Finds exception targets through a separate privacy-aware, non-terminal
  identity search capped at 20 rows, and clears an unfinished exception draft
  when the target changes.
- Paginates gate history, invitation waves, and recipient delivery ledgers
  independently. Each navigation replaces the visible bounded page; it does
  not append an unbounded browser-side pool.
- Ignores or aborts superseded preview/page requests so an older response
  cannot overwrite the current rule, exceptions, or page.

### Decisions

- Keeps the bounded 2–3 candidate comparison and action inbox.
- Uses asynchronous, paginated candidate search rather than loading every job
  application.
- Does not return or imply JD rank in the comparison picker.
- Paginates the action inbox with previous/next replacement pages, never
  append-only accumulation, and makes the current page and result bounds
  visible.

### Performance

- Remains a separate aggregate view and never becomes a candidate-list API.
- Starts every read from the exact workspace/job application boundary rather
  than preloading the workspace candidate directory. Candidate identity is
  loaded only for the capped, fewer-than-ten-score fallback.

## Read/API contract

- Every query is scoped by authenticated workspace and job before joining
  candidate identity or evidence.
- Candidate rows are a narrow projection. They exclude resumes, application
  event arrays, raw scorecard evidence, invite capabilities, provider errors,
  and unrelated cross-job PII.
- Counts and funnel summaries are returned separately from candidate pages.
- Opaque cursors bind the workspace, job, normalized query, frozen timestamp,
  stable tie-breaker, job candidate-read revision, and workspace
  candidate-directory/privacy revision. A cursor cannot be replayed with
  different filters. Both revisions are checked before and after aggregation;
  a semantic mutation returns HTTP 409 `JOB_CANDIDATES_CURSOR_STALE`.
- Pure post-snapshot arrivals and intake-task churn do not invalidate traversal.
  Pending-privacy expiry is evaluated at the frozen timestamp, while the
  private/no-store freshness read uses current privacy visibility and returns
  only whether a new matching application exists.
- Job-local round activity uses semantic invitation/consent/preparation/result/
  revocation timestamps, never generic technical-write timestamps.
- Search/filter/sort validation is fail closed and responses are private,
  `no-store`.
- Secondary member pages (Screening history/waves/recipients, Decisions, and
  bulk-operation issues) use authenticated opaque cursors bound to member,
  workspace, job, resource, limit, and age. Their routes reject unknown or
  repeated query parameters.
- Database indexes are derived from the supported query matrix, explicitly
  prepared and checked, and never delegated to runtime `autoIndex`.
- A new arrival never silently reorders the page under review; the UI polls the
  bounded freshness read and offers a refresh notice.

## Selection and bulk-action contract

- Selection distinguishes explicit candidates accumulated across visited pages
  from `all matching` and always displays the exact count and normalized filter
  description.
- Explicit browser-held selection is capped at 100 candidates; larger cohorts
  use the server-owned `all matching` snapshot instead of submitting a mutable
  client ID list.
- `All matching` creates a short-lived, workspace/job/member-scoped server
  snapshot with an immutable application set. The browser does not submit
  thousands of authoritative IDs.
- The all-matching description persists deterministic normalized non-PII values
  and sort codes, redacts query text as `search applied`, and is bounded to 500
  characters. Snapshot resolution and creation share the active workspace write
  transaction, and privacy erasure invalidates snapshots containing that subject.
- Bulk mutations use per-row expected state and idempotency coordinates and
  produce per-row success, conflict, and controlled-failure outcomes.
- Retrying an operation cannot apply a row twice or apply a different action
  under the same operation coordinate.
- Large work is durable/resumable and does not loop the single-row HTTP route.
- Advance is allowed only for a stage-homogeneous selection. Reject and
  withdraw require reason/communication review and explicit confirmation.
- Bulk hire, offer acceptance, offer decline, and automated rejection are not
  available.
- Privacy redaction, job closure, stage races, and deleted candidates are
  revalidated at execution time.

## Accessibility and responsive behavior

- Tables use real headers, scoped labels, `aria-sort`, and candidate-specific
  selection labels.
- Row navigation and row actions are distinct keyboard targets; the whole row
  is not a click target.
- Selection and bulk outcomes are announced without placing large row trees in
  a live region.
- Focus returns to its trigger after drawers/dialogs and remains predictable
  after row/batch actions.
- Status never depends on colour alone, and drag-and-drop is never the only
  way to move a stage.
- At 200% zoom and narrow mobile widths there is no document-level horizontal
  overflow. Mobile uses cards/filter controls rather than a squeezed table.

## Completion evidence

- Service tests cover tenant/job isolation, cursor/filter binding, global
  ranking, stale/unscored behavior, privacy suppression, search, every saved
  view, stable ordering, and no raw-evidence leakage.
- Route tests cover validation, private caching, membership, bounded Screening
  preview/history/wave/recipient/search pagination, selection snapshots,
  idempotent partial results, and stale-state conflicts.
- Component tests cover URL restoration, keyboard selection, table/card
  parity, screen-reader names, column controls, refresh notices, and handoffs.
- A fixture with at least 1,000 applications proves bounded query/page output,
  correct counts/ranks, and bounded rendered rows.
- Authenticated browser verification covers desktop, mobile, keyboard-only,
  and 200% reflow for Overview, Candidates, Screening, Decisions, and detail
  return navigation.
- Typecheck, lint, module budgets, full tests, production builds for all Hire
  surfaces, GitNexus change detection, index plan/check/apply evidence, CI, and
  deployment health are green before the goal is complete.
