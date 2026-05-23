# ADR 0007: Bump `shared/` Budget — Cross-Module Onboarding Hook

**Status:** Active
**Date:** 2026-05-23
**PR:** #402 (UAT remediation Waves 1-5)

## Context

PR #402 ships a multi-wave UAT remediation pass. Wave 3 (UAT-014) added
`shared/hooks/useOnboardingProfile.ts` — a focused client-side hook that
wraps `/api/onboarding` with in-flight dedup plus a per-user 30 s TTL
cache. Two consumers depend on it:

- `modules/interview/components/InterviewSetupForm.tsx`
- `modules/learn/components/ResourceLinks.tsx`

Both mount on `/interview/setup` and would otherwise fire duplicate
GETs against `/api/onboarding`. Wave 5 (CI fix) routes both through
the hook to share the cache.

After the addition, `shared/` reports **131 of 130 files** in the size
budget (LOC count is untrustworthy from the Windows POSIX `find`
path — see [feedback_check_size_script_runs_on_linux memory], CI uses
Linux and reports the real LOC). Files-count budget tripped CI.

## Decision

Raise `shared/`'s file budget:

- **Files:** 130 → **132** (+2)
- **LOC:** unchanged (25 000)

## Rationale

- **The hook belongs in `shared/`, not in either module.** Both
  consumers live in different domain modules. Putting the hook in
  `modules/learn/` would force `@interview` → `@learn` cross-imports
  (backward dependency that the project's ESLint `no-restricted-imports`
  rule and the modular-monolith architecture explicitly forbid).
  Putting it in `modules/interview/` puts auth/onboarding data inside
  the interview module, which is semantically wrong: onboarding is a
  user-level concern, not interview-specific.
- **Headroom of +1 (132 cap vs. 131 actual) is intentional but small.**
  Wave 3 also widened `shared/cachedFetch.ts` with a sibling
  `deduplicatedFetchJSON` export (same file, no new file). The next
  shared-client hook (e.g. `useSubscription`, `useFeatureFlags`) would
  push files to 132 — fine, but the one after that re-triggers the
  budget. At that point the right structural move is to introduce a
  thin `shared/hooks/` barrel and consider whether the data-shape
  hooks (`useOnboardingProfile`, `usePathwayNextAction`-equivalent)
  warrant a dedicated `shared/data-hooks/` cluster with its own
  budget. Don't bump again without that conversation.
- **Step size matches precedent.** `modules/interview` bumped four
  times in two days (ADRs 0003–0005), then carved out into
  `modules/feedback` once growth pressure became structural rather
  than incidental (ADR 0006). `shared/` has been stable at 130 since
  the modular-monolith refactor; this is its first bump and it's a
  single hook, not a sub-package. ADR 0006-style structural carve-out
  is overkill for one file.

## Consequences

- CI's module-size step passes with PR #402 in place.
- The next shared-hooks bump (above ~134 files) should be a structural
  conversation, not a +N bump.
- Reviewers reading this PR can see why a `shared/hooks/` addition was
  the right call vs. forcing one of the consumers to absorb it.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Move hook to `modules/learn/hooks/`, import from `@interview` | Creates a backward `@interview` → `@learn` dependency cycle; forbidden by the ESLint rule and architecturally wrong (interview is the lower-level domain). |
| Move hook to `modules/interview/hooks/`, import from `@learn` | Onboarding data is user-level, not interview-specific. `@interview` already imports it transitively via `getDomainLabel`; pulling auth state into the interview module muddles the boundary. |
| Inline the hook logic separately in both consumers | Duplicates the per-user TTL cache + the `useSession` integration. Codex P1 on PR #402 was *about* the cache scoping — duplicating it doubles the risk of one copy regressing. |
| Bump `shared/` by +5 for more headroom | Treats the budget as soft. The script comment explicitly says budgets are "early-warning tripwires"; bumping +2 keeps the tripwire close so the next addition triggers another scoped conversation. |
