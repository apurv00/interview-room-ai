# ADR 0042 — Hire media-completion durability budget

Date: 2026-08-21

Status: accepted

## Context

Hire camera and display recordings can outlive interview completion because
large multipart uploads continue after the scorecard is ready. Treating the
session's `completed` status as permission to clear IndexedDB or sign out could
discard consent-required media before its checksum-verified control-plane copy
was acknowledged.

The browser upload queue now distinguishes pending media from a versioned,
durable terminal-unavailable marker. It retains required Blobs across bounded
retries, replaces an expired multipart identity after HTTP 410, aborts blocked
IndexedDB work at explicit deadlines, and performs one bounded completion-page
settlement pass. These changes extend existing replay ownership in
`modules/interview` from 30,968 to 31,524 counted LOC.

## Decision

Raise only the `modules/interview` LOC ceiling from 31,100 to 31,600. Keep the
142-file ceiling unchanged. The measured implementation retains 76 LOC of
headroom.

The queue remains beside its existing recorder and upload implementation. A
move into an unbudgeted Hire-only directory would split generic IndexedDB,
privacy-generation, lease, and multipart invariants across artificial module
boundaries.

## Consequences

- Candidate navigation and sign-out wait for published media or an explicit,
  server-acknowledged unavailable state.
- Retry/open/transaction work remains bounded; no automatic completion poller
  is introduced.
- The next material `modules/interview` growth event should revisit ADR 0006's
  post-interview analysis extraction instead of another numeric bump.
