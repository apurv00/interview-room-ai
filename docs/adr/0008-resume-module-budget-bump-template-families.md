# ADR 0008: Bump `modules/resume` Budget — Family-Based Template System

**Status:** Active
**Date:** 2026-05-29
**PR:** #411 (resume template families + hardening)

## Context

PR #411 refactors the resume template catalog from **10 flat
`*Template.tsx` files** (each ~130 lines of near-duplicate JSX with its own
pagination markers) into a layered system:

- `components/layouts/*` — 7 family layouts (Classic, Technical, Executive,
  Early-Career, Career-Change, Sidebar, Startup)
- `components/template-primitives/*` — ~12 shared presentational pieces that
  own the `data-resume-*` pagination markers ( contact header, section block,
  experience/education/projects/cert lists, skills block, custom sections)
- `config/*Themes.tsx` + `config/sectionOrders.ts` — per-family theme +
  section-order config
- `components/templates/*Template.tsx` — thin legacy shims that delegate to a
  layout with a variant id (keeps every saved `template` id working)
- new parity / sectionOrder / contract tests under `__tests__/`

After the refactor `modules/resume` reports **88 of 70 files**, tripping the
file-count budget. **LOC is unaffected** (~10.6k of 20k) — the change trades
file *count* for reuse and small, single-purpose modules, not total size.

## Decision

Raise `modules/resume`'s file budget:

- **Files:** 70 → **100** (+30; ~12 headroom over the current 88)
- **LOC:** unchanged (20 000)

## Rationale

- **The growth is the architecture, not bloat.** The whole point of the
  family/primitive system is that a section's markup + pagination markers live
  in ONE primitive instead of being copy-pasted across 10 templates. That
  necessarily means more, smaller files — and it is what made the Codex
  pagination-bug class (inconsistent markers across hand-maintained templates)
  structurally preventable. LOC staying flat at ~53% of budget confirms this is
  a count-shape change, not a size regression.
- **Headroom is sized for the variant roadmap, not open-ended.** New *variants*
  are config-only: a theme entry (in an existing file) + a ~6-line shim. ~12
  shim files of headroom covers the near-term planned variants
  (`classic-navy`/`sidebar-slate` already landed) without a re-bump per PR.
- **The next bump should be structural.** Past ~100 files the right move is to
  move the per-family theme configs into a `config/themes/` subdir (or split
  primitives into a sub-cluster), not to keep raising the cap — mirroring the
  ADR 0006 carve-out precedent for `modules/interview`. Don't re-bump past 100
  without that conversation.

## Consequences

- CI's module-size step passes with PR #411 in place.
- Adding a config-only variant no longer trips the budget until ~12 more files
  land.
- A future bump past 100 is a signal to restructure (themes subdir), not to
  treat the budget as soft.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Keep the 10 flat templates | The duplication is exactly what caused the recurring pagination/marker bugs; the refactor is the fix. |
| Inline primitives back into layouts to cut file count | Re-duplicates marker logic across 7 layouts — reintroduces the bug class the primitives eliminate. |
| Bump to a very high cap (e.g. 200) | Treats the budget as soft; the script comment calls budgets "early-warning tripwires". +12 headroom keeps the tripwire close so the next structural decision is conscious. |
| Move theme configs to a subdir now | Premature — 7 theme files is readable flat today; defer the carve-out until file pressure actually returns (documented above as the next step). |
