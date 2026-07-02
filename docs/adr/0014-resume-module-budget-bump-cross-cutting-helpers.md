# ADR 0014: Bump `modules/resume` File Budget — Cross-Cutting Helpers

**Status:** Active
**Date:** 2026-07-02
**PRs:** #491 (resume Phase 2 data-loss fixes), #492 (resume Phase 3 UX polish)

## Context

The resume-builder audit stack adds two counted source files, putting the
module at **101 of 100 files** and tripping CI's size budget:

- `hooks/useDebouncedValue.ts` (PR #492) — debounces `ResumePreview`'s input
  so the synchronous measure pipeline (hidden-DOM layout + pagination re-plan)
  runs once per typing pause instead of on every keystroke. Extracted as a
  standalone hook so it is unit-testable with fake timers (3 tests) and
  reusable; inlining it into the 800-line `ResumePreview.tsx` would dodge the
  budget at the cost of testability.
- `lib/structuredContent.ts` (PR #491, Codex P2 fix) — the
  `hasStructuredResumeContent()` predicate shared by `saveResume` (decides
  whether to regenerate `fullText`) and the builder page (decides whether to
  re-parse on open). It lives in `lib/` **specifically because the builder is
  a client component**: importing the predicate from the mongoose-backed
  `resumeService` would pull the DB driver into the client bundle. The
  previous state — two hand-copied inline predicates — is what drifted apart
  and caused the Codex P2 (projects-only resumes losing fullText freshness).

ADR 0008's caveat ("a bump past ~100 should move themes to a subdir, not
re-bump") targeted **template/theme sprawl**. Neither file is a template
variant; both are cross-cutting helpers whose separate existence is the point
(testability, client-safety). LOC is at ~12.1k of 20k — well under budget.

## Decision

Raise `modules/resume`'s file budget from **100 to 104**: 101 current files
plus +3 headroom for the remaining audit follow-ups. The LOC budget is
unchanged. ADR 0008's theme-subdir guidance still stands for any future
growth that IS template-variant sprawl.

## Consequences

- CI passes at 101 files; the tripwire fires again at 105.
- Template-variant additions should still trigger the ADR 0008 subdir
  refactor rather than another bump.
