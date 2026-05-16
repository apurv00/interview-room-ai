# ADR 0006 — Split feedback UI out of `modules/interview/` into `modules/feedback/`

**Date:** 2026-05-16
**Status:** Accepted

## Context

After the Round 4 multimodal redesign (PR #370), `modules/interview/` had ballooned
to 176 files / ~30k LOC against a budget of 180 / 35k (set in ADR 0005). The
budget had been bumped three times in two days (ADRs 0003 → 0004 → 0005), and
the next post-interview feature would have forced a fourth bump.

The growth was concentrated in one place: post-interview UI.
`components/feedback/` (34 files, ~5.4k LOC) and `components/replay/` (7 files,
~1.7k LOC) together accounted for ~24% of the module — and unlike the rest of
`modules/interview/`, none of it runs during a live interview. It's pure
post-session review.

A separate audit revealed `components/replay/` was dead. The Round 4 redesign
replaced its components (`VideoPlayer`, `MomentCards`, `TimelineTrack`,
`CoachingPanel`, `SignalCharts`) with the new `multimodal/` subdirectory under
`components/feedback/`. `AnalysisTrigger` had no runtime caller — the
`/api/analysis/start` request now fires directly from
`app/feedback/[sessionId]/page.tsx:342`. `ReplayTranscript` was unused. All 7
files were carried for "revert safety" but had no production import path.

## Decision

Carve the post-interview review UI into its own module:

```
modules/feedback/
├── components/
│   ├── *.tsx                          # was modules/interview/components/feedback/*
│   ├── __tests__/                     # was modules/interview/components/feedback/__tests__/
│   └── multimodal/
│       ├── *.tsx, *.ts                # was modules/interview/components/feedback/multimodal/*
│       └── __tests__/
└── index.ts                           # @feedback barrel
```

Delete `modules/interview/components/replay/` (all 7 source files + 6 test files —
all dead code).

**Scope held to UI only.** `services/analysis/` (4 files, multimodal pipeline) and
`jobs/analysisJob.ts` (HOT-PATH per CLAUDE.md) stay in `modules/interview/` for
this PR. Moving them is a follow-up that requires `./scripts/gitnexus-impact.sh`
analysis and full E2E interview verification per the hot-path rules.

## Wiring changes

- **tsconfig.json:** add `@feedback` and `@feedback/*` path aliases pointing at `modules/feedback/`.
- **vitest.config.ts:** mirror the alias so test resolution works.
- **`.eslintrc.json`:** add `@feedback/*` to the cross-module deep-import ban for every other module + add a new override for `modules/feedback/**/*` that mirrors the existing pattern (no deep imports from sibling modules — go through barrels). The `shared/**/*` block gets `@feedback`/`@feedback/*` added so `shared/` stays kernel-pure.
- **scripts/check-module-size.mjs:** add `modules/feedback` entry (10k LOC / 60 files), drop `modules/interview` budget back to 25k LOC / 140 files (was 35k / 180 in ADR 0005).
- **modules/interview/index.ts:** expose `parseQuestionRefs`, `parseQuestionRefSegments`, `categorizeTip`, and `TipCategory` from the barrel so other modules don't need deep-import paths. (See "Trade-off" below — the barrel still isn't safely consumable from client components.)

## Imports

All 24 internal `@interview/components/feedback/*` paths inside the moved files
become `@feedback/components/*`. The single consumer in
`app/feedback/[sessionId]/page.tsx` (4 static imports + 2 dynamic) is updated to
the same alias.

## Trade-off: `@interview` barrel still pulls Redis transitively

`modules/interview/index.ts` re-exports from
`services/persona/documentContextCache.ts`, which imports `shared/redis.ts` →
`ioredis` → `dns`/`net`. Any client component that does `import { X } from
'@interview'` pulls these node-only modules into the client bundle and breaks
the Next.js build.

The pre-existing precedent (in `OverviewTab.tsx`'s import of
`@learn/components/feedback/ComparisonCard`) is an `// eslint-disable-next-line
no-restricted-imports` with an explanatory comment, falling back to a deep path.
The five client components in `modules/feedback/` that need utils from
`@interview` (`parseQuestionRefs`, `categorizeTip`, `computeOffsetSeconds`,
`CONFIDENCE_TREND_LABELS`, `parseQuestionRefSegments`) follow the same precedent.

A proper fix — splitting `@interview` into client-safe and server-only barrels,
or making `documentContextCache` lazy-import Redis — is out of scope for this
split PR and tracked as tech debt.

## Consequences

**File counts after the split:**

| Module | Before | After | Δ |
|---|---|---|---|
| `modules/interview` | 176 files / ~30k LOC | 135 files / ~22k LOC | −41 / −8k |
| `modules/feedback` | — | 35 files / ~7k LOC | new |

**Budgets:**

| Module | Budget before | Budget after |
|---|---|---|
| `modules/interview` | 180 files / 35k LOC | 140 files / 25k LOC |
| `modules/feedback` | — | 60 files / 10k LOC |

**Headroom:** interview drops to 96% utilization (135/140 files) — comfortable
margin for the next handful of changes without budget pressure. Feedback opens
at 58% utilization (35/60), with room for the next several rounds of
post-interview UI work without revisiting this ADR.

**Test impact:** all 120 feedback tests pass. Pre-existing baseline failures
unchanged (10 in `skillLoader.test.ts`, 1 flaky perf test). Total: 2599 passing.

**No runtime change.** The PR is a pure refactor — no behavior, schema, or wire-
format change.
