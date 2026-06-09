# ADR 0010: Bump `modules/learn` File Budget — CTA Next-Step Resolver

**Status:** Active
**Date:** 2026-06-09
**PR:** #435 (homepage CTA stall fix)

## Context

PR #435 fixes the homepage hero CTA, which sat disabled showing "Loading
your next step…" until a client-side `/api/learn/pathway` fetch resolved.
That endpoint is `force-dynamic` and runs ~6 Mongo queries plus a full
view-model build just so the CTA can read one field (`nextAction.href`);
on a cold serverless start it stalled the primary conversion action for
1–3 s.

The fix moves destination resolution off the page's critical path into a
server-side redirect interstitial (`/interview/next`). The resolution
logic lives in a new module file, **`services/resolvePathwayNextHref.ts`**,
which reuses the canonical `buildPathwayViewModel` (so the destination
never diverges from the pathway page / banner) but computes only the
inputs `nextAction.href` actually depends on.

The file-count budget counts **non-test source only**: `countFiles()` in
`scripts/check-module-size.mjs` skips `__tests__/`. So of the PR's two new
`modules/learn` files, exactly **one is counted** —
`services/resolvePathwayNextHref.ts`; the paired
`__tests__/resolvePathwayNextHref.test.ts` is invisible to the budget. The
module sat at the 80 cap, so that single new source file takes it to
**81 of 80**, tripping the gate. **LOC is unaffected** (~14k of 25k) — a
small-util add, not size growth.

## Decision

Raise `modules/learn`'s file budget:

- **Files:** 80 → **82** (+2; ~1 headroom over the current 81)
- **LOC:** unchanged (25 000)

## Rationale

- **The new file is a thin, single-purpose resolver.** It exists to
  decouple a conversion-critical CTA from a heavy personalization endpoint,
  and it reuses existing logic rather than duplicating it. LOC holding at
  ~56% of budget confirms this is not bloat.
- **Headroom stays deliberately tight.** Consistent with the +1-headroom
  convention used for the interview module (ADR 0009): the next net-new
  `modules/learn` source file re-trips the budget and forces another
  conscious decision rather than reflexive growth.

## Consequences

- CI's `check-module-size` step passes with PR #435 in place.
- `modules/learn` sits at 81/82 — effectively at the cap, so the next
  net-new source file is a forcing function for a deliberate review.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Put the resolver inside an existing `modules/learn` file (e.g. `pathwayPlanner.ts`) to avoid a new file | Conflates an HTTP-shaped, view-model-consuming resolver with the plan-generation service; a standalone file is the cleaner boundary and keeps the dependency direction obvious. |
| Inline the resolution in `app/interview/next/page.tsx` (no module file) | Leaves reusable, testable logic in a route component; the unit test (5 cases) would have nowhere clean to target, and the API route would still over-fetch. |
| Bump to a high cap (e.g. 100) | Treats the budget as soft; the tight-tripwire convention argues for +1 headroom, not open-ended room. |
