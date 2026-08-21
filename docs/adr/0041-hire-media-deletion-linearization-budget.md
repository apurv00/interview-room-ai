# ADR 0041 — Hire media deletion linearization budget

Date: 2026-08-21

Status: accepted

## Context

Hire media uploads cross two systems that cannot share one transaction: MongoDB
owns candidate, workspace, and retention state, while object storage owns the
media bytes. Previously, an upload that had already passed its deletion checks
could finish after a privacy, workspace, or test-drive purge and recreate an
object after the database graph was gone.

Closing that race requires one coordinated state machine and object protocol
in the existing Hire media ownership boundary:

- a random per-row nonce is persisted with the staging record before external
  I/O, and new object keys expose only its coordinate-bound SHA-256 digest;
- every v2 media `PutObject` uses `If-None-Match: *`;
- deleting v2 media is an acknowledged, unconditional zero-byte seal at the
  same key, which is never physically deleted or expired afterwards;
- privacy, workspace, candidate, and current job-retention fences are claimed
  in the transactions that reserve and finalize the media row;
- active one-hour ingestion leases block destructive graph completion, while a
  240-second client deadline bounds local resource use without being treated as
  proof that a remote write settled;
- purge workers claim individual rows with unique tokens and acknowledge only
  the exact claim they own; and
- legacy coordinate-bearing v1 objects remain readable and use physical
  deletion, while every new writer is v2-only.

The conditional write and permanent same-key seal linearize both commit
orders: media that commits first is overwritten by the seal, while a seal that
commits first causes the media write to fail its precondition. The rollout is
therefore a cold, no-overlap cutover; an old unconditional writer or a rule
that expires seals would invalidate the guarantee.

The v2 protocol closes every newly minted key, but it cannot retroactively
fence an unconditional v1 request that R2 accepted before the cutover. A
Mongo/R2 reconciliation scan is necessary but a time-separated clean scan is
not, by itself, a settlement barrier. Production activation therefore remains
blocked until the old writers are drained and Cloudflare supplies a documented
request-settlement/cancellation bound that is observed before the final scan,
or the old write namespace is retired with an equivalent provider-enforced
barrier. Treating an arbitrary quiet period as proof is expressly rejected.

These changes touch the media asset schema, storage authority, runtime and
identity ingestion, candidate retention, workspace purge, and test-drive
purge. They add 954 net counted production lines to `modules/hire`, moving it
from 25,590 to 26,544 LOC. Tests are excluded from this budget, and the counted
file total remains 91.

The previous 26,000 LOC limit retained 410 lines over the measured baseline, so
544 lines exceed the existing tripwire. Extracting one of these services solely
to pass the counter would split a single storage/deletion authority and lock
order across modules without reducing the implementation.

## Decision

Raise only the `modules/hire` LOC ceiling from **26,000 to 26,600**. Keep the
file ceiling unchanged at **91**.

| Module | Previous | New | Measured after this change | Headroom |
| --- | ---: | ---: | ---: | ---: |
| `modules/hire` | 26,000 LOC / 91 files | 26,600 LOC / 91 files | 26,544 LOC / 91 files | 56 LOC / 0 files |

This is the smallest rounded increase that admits the deletion-safety state
machine while leaving the tripwire tight. It does not authorize new Hire
features or another file.

## Consequences

- The nonce-bound key, conditional writer, seal, lease, and purge claim
  protocol stays beside the lifecycle transactions it protects.
- CI retains only 56 counted lines of LOC headroom and no file-count headroom.
- The next material Hire-core growth must reduce or reorganize existing code
  under the same counted budget, or justify a real ownership boundary in a new
  ADR; moving files merely to evade this counter is not an acceptable split.

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| Extract ingestion or purge code into an unbudgeted module | It would separate one deletion authority and lock order across module boundaries while leaving the same code and risk in the repository. |
| Compress the lease and claim logic to stay below 26,000 LOC | It would obscure compare-and-set predicates and compensation paths whose explicitness is required for review and regression tests. |
| Keep a time-based quiet period before `DeleteObject` | A timed-out object write has no provider-guaranteed settlement bound, so elapsed time cannot prove that deletion won the race. |
| Permanently seal coordinate-bearing v1 keys | It would retain candidate-linked identifiers in the object namespace after graph deletion. |
| Raise the ceiling to 27,000 LOC | It provides 456 lines of headroom, more than this narrowly scoped remediation needs. |
