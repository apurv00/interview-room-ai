# Frontend Engineer — Coding Interview — Mid Level (3-6 years)

## Problem Types
- **JavaScript Utility Implementation (25%):** debounce (leading/trailing), throttle, Promise.all/race/any, curry, deepClone, memoize, EventEmitter (on/off/emit/once), pipe/compose, deep flatten
- **UI Component Building — Machine Coding (30%):** Autocomplete/typeahead, modal with focus trap, image carousel, star rating, infinite scroll, file explorer/tree, transfer list, multi-step form, accordion, drag-and-drop sortable, data table with sort/filter/paginate
- **React/Framework-Specific (20%):** Custom hooks (usePrevious, useDebounce, useLocalStorage, useFetch), controlled vs. uncontrolled, memoization optimization, Context API, compound components, render props/HOC
- **Async Patterns & API Integration (15%):** Fetch with error/loading/retry, AbortController cancellation, polling with cleanup, async task queue with concurrency limits, race condition prevention
- **Algorithms with Frontend Flavor (10%):** Flatten nested object, simplified JSON.stringify/parse, DOM tree traversal (BFS/DFS), simplified querySelectorAll, DOM tree diff

## Difficulty Level
- **Easy: 20% | Medium: 60% | Hard: 20%**

## Phase Structure
**Format A: Live Machine Coding (45-60 min — most common)**
1. Problem Statement (3-5 min)
2. Clarification & Planning (5-7 min) — questions, API surface, component sketch
3. Implementation (25-35 min) — CodeSandbox or CoderPad
4. Testing & Edge Cases (5-7 min)
5. Follow-up Extensions (5-10 min) — "add accessibility", "handle 10K items", "add keyboard nav"

**Format B: Meta-Style (45 min)**
1. Problem 1 (20 min) — JS utility (debounce, Promise.all)
2. Problem 2 (20 min) — UI component or DOM problem
3. Discussion (5 min) — trade-offs

**Format C: Google Frontend (45 min)**
- Build widget (color picker, slider, star rating) in vanilla JS — no frameworks

## What Makes This Level Unique
- **Machine coding round dominates** — build complete, working components in 30-45 min
- Components in "70% of machine coding rounds": star rating, progress bar, pagination, accordion, modal, infinite scroll
- Handle **real-world concerns**: loading states, error boundaries, debouncing, keyboard nav
- **Framework knowledge tested in practice** — "build this in React" not "explain Virtual DOM"
- Must write **utility functions from scratch** (debounce, throttle, Promise.all) — proving understanding of what libraries abstract
- **Performance awareness evaluated**: when to memoize, virtualize, lazy-load
- Custom hooks are a differentiator
- **Accessibility is a follow-up**: after building, expect "how make accessible?"
- CSS tested **through components built**, not standalone

## Evaluation Criteria
| Dimension | Weight |
|-----------|--------|
| Problem Solving | 25% |
| Code Quality | 25% |
| Technical Competency | 20% |
| Completeness | 15% |
| Communication | 15% |

## Common Frontend-Specific Problems
**Utilities:** debounce with this/args, throttle with trailing, Promise.all with rejection, deepClone (circular refs, Date, Map), EventEmitter, curry, memoize with cache key
**Components:** Autocomplete (debounce+keyboard+race conditions), Modal (Escape+focus trap+scroll lock), Carousel (autoplay+swipe), Star Rating (hover+click+half-star+a11y), Infinite Scroll (IntersectionObserver), Nested File Explorer (recursive)
**React:** useDebounce hook, useFetch with AbortController, usePrevious, optimize 1000-item list
**CSS in Components:** Holy Grail layout, responsive card grid, sticky sidebar, animated progress bar

## Anti-Patterns
- Building without planning
- Prop drilling through 5 layers instead of Context/composition
- No async cleanup (missing AbortController, memory leaks)
- useEffect for everything (derived state, event handlers that shouldn't be effects)
- Incorrect dependency arrays (infinite loops, stale closures)
- `index` as key in dynamic reorderable lists
- Over-engineering (Redux for useState scenarios)
- innerHTML for user content (XSS)
- Not debouncing search/autocomplete

## Sources
- Front End Interview Handbook 2026 — Machine Coding
- GreatFrontEnd — JavaScript Coding Questions
- GreatFrontEnd — User Interface Coding Questions
- DevTools Tech 200+ Questions (GitHub)
- Meta Frontend Engineer Guide (Prepfully)
- BFE.dev Frontend Coding Problems
