# Frontend Engineer — Technical Interview — Mid Level (3-6 years)

## Topic Sequence (typical order)
1. **Advanced JavaScript** — Closures in practical contexts, prototypal inheritance, event loop internals (microtasks vs macrotasks), generators, Proxy/Reflect, WeakMap/WeakSet
2. **State Management Architecture** — Redux vs. Zustand vs. Context+useReducer; global vs. local state; client state vs. server state; normalization
3. **React/Framework Deep Dive** — Reconciliation algorithm, fiber architecture, hooks rules/internals, custom hooks, error boundaries, Suspense, concurrent features
4. **Performance Optimization** — Core Web Vitals (LCP/INP/CLS), code splitting, lazy loading, memoization (`useMemo`/`useCallback`/`React.memo`), bundle analysis, tree shaking
5. **CSS Architecture** — BEM vs CSS-in-JS vs utility-first (Tailwind); CSS Modules; design tokens; container queries; specificity management at scale
6. **Testing Strategies** — Unit (Jest/Vitest), component (React Testing Library), E2E (Cypress/Playwright), testing pyramid, mocking strategies
7. **TypeScript** — Generics, utility types (`Partial`, `Pick`, `Omit`, `Record`), discriminated unions, type narrowing, `infer`, mapped types
8. **Build Tools & Bundling** — Webpack vs. Vite vs. Turbopack; tree shaking; code splitting; HMR; source maps; environment config
9. **Accessibility Implementation** — WCAG 2.1 AA, ARIA attributes/roles, focus management in SPAs, screen reader testing, keyboard navigation
10. **API Integration Patterns** — REST vs. GraphQL client-side; data fetching hooks (SWR, React Query); caching, pagination, optimistic updates

## Phase Structure
- **Conceptual depth check (10 min):** Deep JS internals (event loop, closures in real scenarios), framework internals (reconciliation, fiber)
- **Architecture discussion (15 min):** "How would you architect state management for X?" — expects specific tools, metrics, tradeoffs
- **Coding exercise (20 min):** Implement debounce with cancel/flush, custom hook, Promise.all, or virtualized list — production-quality expected
- **Testing & tooling (5-10 min):** "How do you decide unit test vs E2E?" / "Walk me through ideal CI for a React app"

## What Makes This Level Unique
- **JS and framework internals expected** — "how does React know when to re-render?" demands reconciliation understanding, not just "Virtual DOM"
- **TypeScript is assumed** — generics are "the dividing line between junior and senior TypeScript"
- Expect **production-scale experience**: bundle analysis with real tools (Webpack Bundle Analyzer), performance with Lighthouse/DevTools, a11y with axe/VoiceOver
- **Testing strategy** differentiates mid from junior — must articulate what to test, what not to, and why
- **State management architecture** tests decision-making — "when would you NOT use Redux?"
- Core Web Vitals questions expect **specific numbers** (LCP < 2.5s, CLS < 0.1, INP < 200ms) and techniques

## Anti-Patterns (do NOT ask at this level)
- HTML/CSS fundamentals any entry-level candidate should know
- Micro-frontends, design systems at scale, build pipeline architecture (senior territory)
- Pure algorithm questions disconnected from frontend
- Accepting "I'd use Redux" without probing WHY and alternatives
- Not asking about testing at all
- Asking about one framework exclusively when candidate has different experience

## Probe Patterns
- State management: "You said Redux. Downsides? When would Context suffice? What about Zustand?" (breadth + decision-making)
- Performance: "You mentioned lazy loading. How decide what to lazy load? Waterfall impact? How measure if it helped?" (practitioner vs. blog reader)
- TypeScript: "Show how you'd type a generic API response handler for any endpoint" (practical generics)
- Testing: "Most valuable test you've written? A test you deleted because it wasn't providing value?" (testing philosophy)
- CSS architecture: "New project. How choose between Tailwind, CSS Modules, styled-components?" (architectural thinking about styling)

## Sources
- hackajob — Frontend Developer Interview Preparation Guide
- Toptal — React Interview Questions 2026
- GreatFrontEnd — 100+ React Interview Questions
- DataCamp — Top 40 TypeScript Interview Questions 2026
- clientside.dev — Frontend Performance Interview Questions
- web.dev — Core Web Vitals
