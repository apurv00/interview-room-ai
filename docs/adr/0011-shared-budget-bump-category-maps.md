# ADR 0011: Bump `shared` File Budget — Category Translation Maps

**Status:** Active
**Date:** 2026-06-09
**PR:** #437 (domain taxonomy Phase 1)

## Context

Phase 1 of the domain-taxonomy redesign de-gates `/api/domains` so the DB is the
source of truth, which exposes CMS-created roles. Bucketing them correctly
requires translating between the legacy free-form `category` label and the new
`categorySlug`, in two places that must agree:

- the **seed / read path** (`shared/db/seed.ts`, server) — `resolveCategorySlug`
- the **CMS domain forms** (`app/(cms)/cms/domains/*`, client)

`shared/db/seed.ts` imports mongoose, so a client form cannot reuse its maps. To
avoid duplicating (and drifting) the translation across server and client, the
maps + validators move into a new **client-safe** module,
`shared/taxonomy/categoryMaps.ts` (no DB imports): `isKnownCategorySlug`,
`CATEGORY_SLUG_FOR_LEGACY`, `LEGACY_FOR_CATEGORY_SLUG`, `legacyCategoryFor`,
`toFormCategorySlug`.

The file-count budget counts **non-test source only** (`countFiles()` skips
`__tests__/`), so of the PR's two new `shared/` files exactly **one is counted** —
`taxonomy/categoryMaps.ts`; its test is invisible to the budget. The `shared`
module sat at the 132 cap, so that single file takes it to **133 of 132**,
tripping the gate. **LOC is unaffected** (~13k of 25k).

## Decision

Raise `shared`'s file budget:

- **Files:** 132 → **134** (+2; ~1 headroom over the current 133)
- **LOC:** unchanged (25 000)

## Rationale

- **The new file removes duplication, not adds bloat.** A single client-safe
  source of truth is precisely what stops the seed and the CMS forms from
  drifting on the legacy↔new mapping — the class of bug Codex flagged on this PR.
- **Headroom stays tight.** Consistent with the convention used elsewhere
  (ADR 0009/0010): +1 headroom so the next net-new `shared/` file re-trips the
  gate and forces a conscious decision.

## Consequences

- CI's `check-module-size` step passes with PR #437 in place.
- `shared` sits at 133/134 — effectively at the cap.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Duplicate the maps in `seed.ts` and inline in each form | Re-creates the drift the maps exist to prevent; three copies to keep in sync. |
| Put the maps in `modules/interview/config/staticData.ts` (already client-safe) | `shared/db/seed.ts` cannot import from a module (`shared → module` is banned by the ESLint boundary rule); the shared seed needs them too. |
| Bump to a high cap | Treats the budget as soft; the tight-tripwire convention argues for +1 headroom. |
