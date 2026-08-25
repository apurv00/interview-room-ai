# ADR 0049: Human-readable Hire workspace sign-in slugs

- Status: Accepted
- Date: 2026-08-28

## Context

Password sign-in currently asks an HR member to type the MongoDB ObjectId of
their workspace. The coordinate is not secret, but it is implementation detail
and is difficult to recognize, communicate, and save correctly. Company names
cannot safely replace it directly: display names can be duplicated or renamed,
and one work email may legitimately belong to more than one workspace.

The existing ObjectId-bearing setup credentials, session cookies, member
indexes, and downstream workspace fences are security boundaries. This change
must not replace any of them with a client-provided name.

## Decision

Each Hire workspace receives an immutable, globally unique `signInSlug` such
as `acme` or, on collision, `acme-1a2b3c4d`.

- The slug is public routing metadata, never authorization.
- Sign-in resolves an exact slug to the internal workspace `_id`, then performs
  the same `(workspaceId, normalizedEmail)` member lookup and creates the same
  ObjectId-scoped session as before.
- A legacy 24-hex workspace ID remains accepted during migration.
- Company display names remain mutable and non-unique.
- Reserved route words, punycode prefixes, and ObjectId-looking values cannot
  become slugs.
- Missing workspace/member paths perform the same one bcrypt comparison as a
  valid-looking login, and all credential failures retain one generic response.

A separate `HireWorkspaceSignInSlug` namespace reserves the SHA-256 hash of
every slug. Active rows contain the slug and workspace ID. Hard workspace purge
transactionally removes those live fields but retains the hash in `retired`
state. Consequently, a slug saved in an old password manager can never resolve
to a different future tenant, while the purge tombstone retains no company
name or workspace coordinate.

The setup and session formats remain `<workspaceObjectId>.<randomSecret>`.
They are internal, self-routing capabilities; changing them is outside scope.

## Rollout and rollback

The application dual-reads slugs and legacy ObjectIds. New workspaces dual-write
the workspace field and reservation. A plan/check/apply command deterministically
backfills existing workspaces and creates two explicit unique partial indexes.
Hard purge must be paused with zero active executions before the rolling deploy,
then the application must be deployed on every create/purge worker before backfill.
After reservations exist, rollback to a pre-reservation hard-purge worker is
allowed only while hard purge is paused; otherwise it could delete a workspace
without retiring its active reservation. Data rollback is neither required nor
allowed, and retirement reservations must never be dropped.

The release gate is documented in
`docs/runbooks/hire-workspace-signin-slugs.md`.

## Budget decision

The namespace is an auditable model boundary rather than hidden raw-collection
logic. Integrated with the candidate-scale release, it increases `modules/hire`
from 92 to 93 counted files and from 28,265 to 28,618 LOC. The budget moves to
28,650 LOC / 94 files, leaving one file and 32 lines of explicit headroom.
Further authentication growth should
be extracted into a reviewed top-level boundary rather than re-bumping this
module casually.
