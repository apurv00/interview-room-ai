# ADR 0017: shared maxFiles 145 → 148 — jobs email wave infrastructure

Date: 2026-07-15 · Status: accepted · Relates: EMAILS.md (spec of record, PR #530), ADR 0016

## Context

The jobs email wave (EMAILS.md §6) adds three cross-cutting files that
belong in `shared/` by the module rules:

- `shared/db/models/JobsEmailSend.ts` — the send ledger (unique dedupe
  index). A DB model; models live in the shared kernel.
- `shared/db/models/JobsEmailConfig.ts` — the per-stream switch singleton
  (data switches, never env flags — founder ruling 2026-07-13).
- `shared/services/signedActionToken.ts` — HMAC token mint/verify for
  unsubscribe + one-tap actions. Shared because the legacy
  `/api/learn/unsubscribe` retrofit (filed fast-follow) consumes the same
  helper — placing it in `modules/jobs` would force a cross-module import.

`shared` sat at 1 counted file of headroom (ADR 0016 set 145).

## Decision

Bump `shared.maxFiles` 145 → 148. LOC budget untouched (~15k/25k used;
these three files add ~230 LOC). No logic sprawl: two models and one
40-line-of-logic helper, all with single responsibilities.

## Consequences

Headroom returns to ~1 file. The next shared addition needs its own ADR —
which is the intended friction.
