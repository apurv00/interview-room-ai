# ADR 0001: Modular Monolith Architecture

**Status:** Active  
**Date:** 2026-04-09

## Context

Interview Prep Guru started as a simple mock-interview simulator and grew into a multi-product platform (interview engine, multimodal analysis, learning/competency tracking, B2B hiring, resume builder, CMS). At ~145k LOC with 5 domain modules, we evaluated whether to keep the modular monolith or migrate to microservices.

## Decision

Keep the modular monolith. The codebase is organized as 5 domain modules (`interview`, `learn`, `resume`, `b2b`, `cms`) plus a `shared/` kernel, with barrel exports enforcing public APIs and ESLint rules preventing cross-module deep imports or shared-kernel dependencies on modules.

## Rationale

- **Domains are not independent.** Personalization reads from competency state, interview sessions, weakness clusters, and XP simultaneously. Splitting into services would turn these into distributed joins.
- **Team is small.** Microservices multiply operational surface (deploys, observability, versioning, contracts). Vercel's single-project model keeps this tax near zero.
- **Cost stays low.** One Vercel project = one cold-start pool, one build-minutes budget, shared dependencies. Splitting doubles or triples infra cost with no user-facing benefit.
- **The real gaps were missing primitives** (background jobs, boundary enforcement), not wrong architecture. Adding Inngest and ESLint rules solved the actual pain points without re-platforming.

## Consequences

- All domain logic lives in one repo and deploys as one Next.js app.
- Module boundaries are enforced by convention (barrels) and tooling (ESLint `no-restricted-imports`).
- The `interview` module's internal sub-module split (services/core, eval, analysis, persona) prevents it from becoming an undifferentiated blob as it grows.
- CI checks module size budgets as an early-warning system.
