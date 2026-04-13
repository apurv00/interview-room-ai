# Frontend Engineer — Coding Interview — Senior Level (7+ years)

## Problem Types
- **Advanced JS & Language Internals (20%):** Simplified Virtual DOM diffing, JSON.stringify with full spec, lightweight reactive state system (signals/observables), Function.prototype.bind from scratch, plugin system, complex TypeScript utility types, event loop deep dive, memory leak patterns
- **System-Level UI Components (25%):** Autocomplete with debounce+cache+race conditions+virtual scroll+a11y, spreadsheet with cell editing+formulas+undo/redo, rich text editor core (contentEditable, formatting, selection API), drag-and-drop Kanban with optimistic updates, virtualized list (100K rows), collaborative editor (CRDT concepts)
- **Framework Internals & Architecture (20%):** Simplified useState/useEffect (hooks linked list, closure, fiber), basic component rendering system (JSX→vDOM→DOM), reconciliation/diffing, client-side router (history API, lazy loading), state management library (pub/sub, selectors, middleware), micro-frontend composition
- **Performance & Optimization (15%):** Profile/optimize slow React tree, request dedup+response caching, Web Worker computation offloader, IntersectionObserver lazy images, bundle-splitting strategy, code-split route tree with preloading
- **Advanced Async & Concurrency (10%):** Task scheduler with priority+concurrency+cancellation, retry with exponential backoff+jitter, WebSocket manager with reconnection+buffering+heartbeat, offline-first data sync, service worker caching
- **TypeScript Advanced (10%):** DeepPartial<T>, PathOf<T>, conditional types+infer, type-safe event emitter, branded/opaque types

## Difficulty Level
- **Easy: 5% | Medium: 40% | Hard: 55%**
- Hard = complex multi-faceted problems requiring architectural thinking, not algorithmic tricks

## Phase Structure
**Format A: Deep-Dive Coding (45-60 min, FAANG)**
1. Problem Statement (2-3 min) — Open-ended: "Build an autocomplete" or "Implement simplified virtual DOM"
2. Scoping & Design (8-12 min) — Candidate drives: API surface, data flow, component hierarchy. IS part of evaluation.
3. Core Implementation (20-25 min) — Real-time architecture decisions while coding
4. Extension & Hardening (10-15 min) — "Handle 100K items", "Add undo/redo", "Screen reader support"
5. Architecture Discussion (5 min) — Testing, deployment as library, 10x scale

**Format B: Meta AI-Assisted Coding (2025+)**
- Same problems but with AI copilot available; evaluation shifts to directing AI, reviewing output, handling what AI gets wrong
- At E6+: Only one coding round but AI-assisted

**Format C: Staff — Architecture-in-Code**
- "Design and implement the core of X" (state management library, component system, form framework)
- Evaluation on design decisions as much as implementation

## What Makes This Level Unique
- **You drive the interview** — open-ended prompt, you define scope and make architectural decisions
- **Framework internals fair game** — "implement simplified useState" tests understanding vs. usage
- **Production quality is baseline** — error handling, TypeScript, edge cases, performance, a11y all expected
- **Follow-up is the real test** — initial implementation should be quick; extending it (undo/redo, 100K items, a11y, collaborative) is the hard part
- **AI-assisted coding emerging** at Meta (2025+) — evaluation shifts to architecture + AI review
- **Performance not theoretical** — may profile live, identify bottlenecks, optimize in real-time
- **TypeScript mastery expected** — creating complex generic utility types, deep type system understanding
- **DSA still matters at Google** — even for senior frontend, expect 2 algorithm rounds
- **System design overlaps with coding** at staff level — may build working prototype of designed system

## Evaluation Criteria
| Dimension | Weight |
|-----------|--------|
| Architecture & Design | 30% |
| Technical Depth | 25% |
| Code Quality | 20% |
| Problem Solving | 15% |
| Communication & Leadership | 10% |

**Senior vs Staff:** Senior = deep technical competency, build complex systems independently. Staff = also define problem, consider org impact, technology choices that scale across teams, mentor through code.

## Common Frontend-Specific Problems
**JS Internals:** Virtual DOM (createElement→vNode, render→DOM, diff→patches, patch→update), Function.prototype.bind supporting `new`, reactive signals (createSignal, createEffect), nested setTimeout+Promise+queueMicrotask output prediction
**System Components:** Virtualized List (visible+buffer, variable height, scroll maintenance), Spreadsheet (formula parsing, dependency graph, undo/redo, range operations), Rich Text Editor (contentEditable, toolbar commands, paste sanitization), Real-Time Kanban (optimistic UI, WebSocket sync)
**Framework Internals:** useState (closure storage, re-render trigger, batching, functional updater), useEffect (dependency tracking, cleanup, comparison logic), SPA router (pushState/popstate, params, nested routes, lazy loading), State store (createStore, dispatch, subscribe, middleware)
**Performance:** Fix 50ms render bottleneck (memo, context, list optimization), Web Worker pool with message passing, Request cache with TTL+LRU+dedup

## Anti-Patterns
- Over-abstracting prematurely (framework when simple solution suffices)
- Not scoping the problem before implementing
- Treating as mid-level round (just build without discussing architecture, testing, extensibility)
- Ignoring reflow/repaint costs, layout thrashing, compositor-friendly animations
- Framework tunnel vision (can't use vanilla DOM APIs)
- Gold-plating one area while ignoring others
- Not discussing trade-offs unprompted
- Dismissing accessibility as "nice to have"
- Writing `any` everywhere in TypeScript

## Sources
- Front End Interview Handbook 2026
- Google Frontend Questions (Frontend Interview Handbook)
- Meta Frontend Guide (Prepfully)
- interviewing.io — Senior Engineer's Guide to FAANG
- GreatFrontEnd — GFE 75 Most Important Questions
- BFE.dev Frontend Coding Problems
