# ADR 0018: readiness-wave budgets — shared 148→149, modules/jobs tripwire added

Date: 2026-07-16 · Status: accepted · Relates: READINESS.md (spec, PR #537), ADR 0016/0017

## Context

PR-R1 (attribution) adds `shared/db/models/JobPracticeEvidence.ts` — its
own collection because replace-not-duplicate needs a REAL unique index
({sessionId, requirementId, xrayHash}) and array subdocs cannot carry one
(panel findings R12/R24; ServedProblem precedent). One counted shared file.

The adversarial panel also flagged (R27) that `modules/jobs` — now the
largest feature module — had no size-budget row at all.

## Decision

- shared maxFiles 148 → 149 (headroom returns to ~1; next addition needs
  its own ADR — intended friction).
- `modules/jobs` gains a tripwire row: maxLOC 14k / maxFiles 70 (currently
  ~9k / ~50 — generous headroom per the file's philosophy; the row exists
  so growth is a decision, not an accident).

## Consequences

Readiness PR-R2/R3 additions live inside modules/jobs and consume its new
headroom; any future shared model (none currently planned for the wave)
re-opens the budget conversation.
