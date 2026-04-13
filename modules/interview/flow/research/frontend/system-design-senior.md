# Frontend Engineer — System Design Interview — Senior Level (7+ years)

## Topic Sequence (typical order)
1. **Design a real-time collaborative editor** (CRDT/OT conflict resolution, cursor presence, offline sync, permissions)
2. **Design a design system at scale** (component library architecture, design tokens, theming, versioning, governance, cross-team adoption)
3. **Design a real-time dashboard for millions** (data streaming, aggregation, charting, WebSocket fan-out)
4. **Design frontend for video conferencing** (WebRTC, media streams, layout management, bandwidth adaptation)
5. **Design micro-frontend architecture** (module federation, shared deps, routing, deployment independence, team boundaries)
6. **Design offline-first application** (service workers, IndexedDB, sync strategies, conflict resolution, background sync)
7. **Design a rich text editor** (document model, plugin architecture, undo/redo, collaborative editing, format extensibility)
8. **Design frontend observability platform** (error tracking, performance monitoring, session replay, sampling)
9. **Design frontend feature flag system** (client-side evaluation, gradual rollout, A/B testing, bundle impact)
10. **Design collaborative spreadsheet** (formula engine, cell dependency graph, virtual grid rendering, real-time updates)

## Phase Structure (extended RADIO, 45-60 min, may have TWO system design rounds)
- **Requirements & constraints (5-10 min):** Deep requirements, non-functional (latency budgets, offline tolerance, a11y standards, i18n), primary user journeys
- **High-level architecture (10-12 min):** System-level component diagram, rendering strategy with justification, CDN/edge, API layer, real-time architecture
- **Data model & state architecture (10-12 min):** Client-side state topology (local vs. global vs. server cache), sync, conflict resolution, normalization, persistence
- **Component & API interface (8-10 min):** Component contracts, composition, plugin/extension architecture, API versioning, backward compat
- **Deep dive on 2-3 areas (10-15 min):** Performance at scale, accessibility architecture, security, testing, deployment/rollout

## What Makes This Level Unique
- Architect systems scaling to **millions of users AND dozens of engineering teams**
- Must discuss **organizational implications** (team autonomy, code ownership, deployment independence)
- Knowledge of **advanced frontend concepts**: CRDTs, service workers, Web Workers, SharedArrayBuffer, WebAssembly
- Must propose **monitoring and observability** strategies
- Discuss **rendering at scale**: streaming SSR, partial hydration, resumability, islands architecture
- Reference **real industry solutions** (Figma real-time, Google Docs OT, Meta React optimization)
- **Security mandatory**: XSS prevention, CSP, subresource integrity, token management
- Balance **technical depth with breadth** — go deep on 2-3 areas while showing awareness of all dimensions
- Senior quickly works through basics **leaving time for depth** in critical areas

## Common Problems/Scenarios
- "Design frontend architecture for Google Docs"
- "Design a design system for 20+ teams across 5 products"
- "Design frontend for real-time stock trading platform"
- "Design collaborative whiteboard like Figma/Excalidraw"
- "Design micro-frontend platform for 15 teams"
- "Design frontend for streaming service like Netflix"
- "Design IDE in the browser (VS Code for Web)"
- "Design real-time multiplayer game lobby UI"
- "Design offline-first social media frontend"
- "Design search experience for e-commerce with 10M products"

## Anti-Patterns (do NOT expect at this level)
- Framework tunnel vision ("I'd use React" without rendering strategy discussion)
- Ignoring the human system (architecture that requires unrealistic team coordination)
- Backend envy (spending time on databases instead of frontend architecture)
- No performance budget (no concrete targets like "FMP under 1.5s")
- Skipping security (no XSS, CSRF, CSP mention)
- Shallow trade-off analysis ("SSR is better" without use-case specifics)
- No monitoring/observability story
- Bleeding-edge without fallback (no browser compatibility consideration)

## Probe Patterns
- "Conflict resolution when two users edit same paragraph?"
- "Walk through request waterfall from URL to interactive page. Bottlenecks?"
- "Migrate monolith to micro-frontends without breaking existing functionality?"
- "Keep design system backward-compatible across 20 teams?"
- "Handle graceful degradation when WebSocket fails at scale?"
- "Prevent one team's bad code from crashing entire frontend?"
- "Architect for low-end Android devices in emerging markets?"
- "Caching hierarchy — service worker to CDN to browser. How interact?"
- "Measure success 6 months after launch?"
- "60% of users on mobile — what changes?"
- "SEO for heavily interactive SPA?"
- "Testing pyramid for this system?"

## Sources
- System Design Handbook — Frontend System Design Complete Guide 2026
- JavaScript in Plain English — Senior Engineer's Complete Guide
- medhat.dev — Cracking Frontend System Design Interview
- Frontend Masters — Frontend System Design Course
- Awesome Frontend System Design (GitHub)
- GreatFrontEnd Evaluation Axes
