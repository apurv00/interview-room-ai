# ADR 0036 — Mandatory Hire department catalog

Date: 2026-08-16

Status: accepted

## Context

Hire v2 originally grouped every requisition only by workspace. That made
portfolio, pipeline-health, and closeout tracking ambiguous as soon as one
company hired for more than one functional area. A nullable free-text label
would preserve that ambiguity and would make every downstream report choose
between silently dropping unclassified jobs and inventing a grouping later.

The existing `modules/hire` boundary is already at its intentional 90-file
budget. Department catalog commands also have a different responsibility from
pipeline transitions: catalog ownership, reserved system entries, archive
policy, safe backfill, and a required foreign key on every job.

## Decision

Create `modules/hire-departments` with the `@hire-departments` alias and an
initial budget of **5,000 counted LOC / 20 counted files**.

- Every `HireJob` has a required workspace-scoped `departmentId`.
- A department is a workspace catalog row, not a second tenancy or permission
  boundary. Applications, candidates, rounds, evidence, and artifacts derive
  the department through their job and do not duplicate the field.
- Ordinary jobs may use only an active `standard` department. Workspace admins
  create, archive, and restore the catalog; active members may select an
  active standard entry while creating or duplicating a job.
- System `legacy` and `onboarding` entries are non-selectable. The former
  catches historical jobs during the explicit migration; the latter classifies
  the synthetic “Interview yourself” job while the existing onboarding marker
  continues to exclude it from reports and operations.
- Archived names remain reserved by a normalized workspace-local unique key.
  Existing jobs retain their department reference, but new or duplicated jobs
  cannot target an archived entry.
- Department reassignment is a dedicated metadata command, deliberately
  separate from the high-impact job-status lifecycle command.

## Consequences

- A deployment must run the explicit legacy backfill before application code
  that serializes required `departmentId` values is promoted. During the
  final backfill/check-to-promote interval, the Hire control writer must be
  drained or put into a short maintenance window: an older writer could
  otherwise create a final null-department job after the check passes.
- The department index script follows the project’s plan/check/apply-only
  pattern; it never uses `syncIndexes` or drops an index.
- Workspace hard purge deletes department rows only after job rows. Report
  snapshots use their own immutable display labels rather than depending on a
  live catalog record.
- Future department-level permissions, approval chains, scorecards, or
  pipelines require a separate decision. They are not implied by this catalog.
