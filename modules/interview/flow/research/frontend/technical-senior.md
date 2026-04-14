# Frontend Engineer — Technical Interview — Senior Level (7+ years)

## Topic Sequence (typical order)
1. **Rendering Strategy Architecture** — SSR vs. CSR vs. SSG vs. ISR; streaming SSR; React Server Components; edge rendering; when to use which
2. **Design System Architecture** — Component library for 10+ teams; design tokens; theming; Storybook; versioning/publishing as npm packages; governance
3. **Micro-Frontend Architecture** — Module Federation (Webpack 5); host/shell; shared dependency negotiation; state sharing; independent deployment; error boundaries
4. **Performance Engineering at Scale** — Performance budgets (250KB threshold triggering tickets); Lighthouse in CI; 100K+ row rendering; Web Workers; WASM; INP optimization
5. **Accessibility at Organizational Scale** — a11y in CI/CD; accessible name computation; focus management in complex SPAs; ARIA live regions; WCAG AA vs AAA strategy
6. **Build Pipeline & Developer Experience** — Monorepo tooling (Nx, Turborepo); build time optimization; linting/formatting standards; feature flags; migration between build tools
7. **Advanced TypeScript** — Conditional types, `infer`, template literal types, recursive types, type-safe API layers, branded types, `satisfies`
8. **State Management at Scale** — Server vs client state separation; optimistic updates with rollback; real-time data; offline-first; state sync across micro-frontends
9. **Testing Architecture** — Design system testing; visual regression; contract testing for micro-frontends; performance testing in CI; a11y automation
10. **Frontend Observability & Reliability** — Error tracking (Sentry), RUM, Core Web Vitals dashboards, feature flag kill switches, graceful degradation, error boundary architecture

## Phase Structure
- **Architecture deep dive (20-25 min):** ONE system design problem — "Design a design system for 10 teams" or "Architect micro-frontend platform" — 5 min requirements, 5 min HLD, 10 min deep dives, 5 min tradeoffs
- **Technical depth probes (15-20 min):** Deep dives into claimed expertise — rendering tradeoffs, performance case studies with numbers, a11y implementation
- **Strategic thinking (5-10 min):** "How improve DX across 10 frontend teams?" — tests organizational thinking

## What Makes This Level Unique
- **Architecture, not implementation** — designing systems other engineers build
- **Accessibility differentiates senior from mid** — accessible name computation, aria-live strategies, organizational a11y programs
- Micro-frontend questions test **governance and coordination**, not just technical — "how handle team that doesn't want to adopt?"
- **Performance is engineering, not optimization** — budgets in CI, automated Lighthouse gates, organizational processes
- **DX leadership** is a senior/staff signal — build times, monorepo standards, unified tooling
- Deep **rendering strategy tradeoffs** — SSR server load, SSG build limits, ISR cache invalidation, RSC component model changes
- **Module federation internals**: remote entries, shared dependency version negotiation, deployment independence
- Interview favors **tradeoff discussion** over implementation — "downsides of your approach?" carries more weight than "how implement?"

## Anti-Patterns (do NOT ask at this level)
- Entry/mid-level CSS fundamentals, basic hooks, JS basics
- Pure coding challenges testing speed rather than architecture
- Single framework without cross-framework thinking
- Backend system design (database, microservices) instead of frontend architecture
- Not asking about **organizational impact**
- Accepting "we used micro-frontends" without probing deployment model, shared state, DX cost

## Probe Patterns
- Design systems: "Team X won't adopt because it doesn't fit their use case. What do you do?" (organizational influence)
- Micro-frontends: "Downsides of Module Federation? When recommend against micro-frontends?" (knowing when NOT to)
- Performance: "Walk through performance budget process from detection to resolution. Who involved? Thresholds?" (organizational capability)
- Rendering: "Migrating large CSR app to SSR. Three biggest risks and mitigations?" (migration planning)
- Accessibility: "How ensure a11y doesn't regress after initial compliance?" (sustainable strategy)
- Build tools: "Frontend monorepo build takes 45 min. Diagnosis and optimization plan?" (systematic engineering)

## Sources
- Frontend Interview Handbook 2026 — System Design
- System Design Handbook — Frontend System Design Complete Guide 2026
- JavaScript in Plain English — Frontend System Design Senior Engineer's Guide
- Frontend Mastery — System Design Interview Definitive Guide
- GreatFrontEnd — Front End System Design Playbook
- LiveLoveApp — 20 Questions on Micro Frontend Architecture
