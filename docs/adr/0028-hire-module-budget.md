# ADR 0028 — New `modules/hire` module + size budget (10k LOC / 45 files)

Date: 2026-08-08
Status: accepted

Implementation note (2026-08-24): the planned retirement described below was
completed on 2026-08-09 when the org-based Hire v1 pages, routes, and services
were deleted. References below to `modules/b2b` describe the historical state
at the time of this decision and are retained as ADR history.

## Context

IPG Hire v2 (docs/ipg-hire-build-plan.md) is a workspace-based hiring tool:
flat-permission workspaces, guest links instead of accounts, a fixed pipeline,
and evidence-linked AI interview rounds. The existing `modules/b2b` is the v1
Organization/recruiter-role product; v2 deliberately replaces its permission
model, so building v2 inside `modules/b2b` would (a) tangle two incompatible
tenancy primitives in one module and (b) blow b2b's 5k/20 budget (v1 already
uses 1k/6; Phase 1 alone adds ~3k/15).

`shared/` is at 166/167 files — effectively zero headroom — so the v2 models
cannot live in `shared/db/models/`. `modules/payments/models/` (ADR 0027 era)
is the precedent for module-local Mongoose models with identical registration
semantics.

## Decision

- New top-level module `modules/hire/` with local `models/` (Workspace,
  WorkspaceMember, Job, Candidate, Application, Round), `services/`,
  `validators/`, `emails/`, and barrel. Aliases `@hire` / `@hire/*`.
- ESLint `no-restricted-imports`: `@hire/*` deep imports barred from every
  other module; `modules/hire` may import other modules only via barrels and
  is barred from all of them by default (it currently imports only `@shared`).
- Budget: **maxLOC 10_000, maxFiles 45** — sized for the whole 5-phase build
  plan (pipeline + kits + share packets + reports), not just Phase 1, so the
  budget acts as a tripwire against scope creep beyond the plan rather than a
  ratchet needing a bump per phase.

## Consequences

- v1 `modules/b2b` remains untouched and independently retireable once v2
  reaches parity (planned after Phase 3).
- Cross-tenant scoping (`workspaceId` on every query) is enforceable per
  service inside one module, with a dedicated isolation test suite.
