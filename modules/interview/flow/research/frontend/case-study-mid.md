# Frontend Engineer — Case Study Interview — Mid Level (3-6 years)

## Topic Sequence (typical order)
1. **Build a real-time dashboard widget** (live data, charts, WebSocket/SSE updates)
2. **Implement a reusable data table** (sorting, pagination, filtering, virtual scrolling)
3. **Design and build autocomplete/typeahead** (debouncing, caching, keyboard nav, API integration)
4. **Create drag-and-drop interface** (kanban board, reorderable list, transfer between lists)
5. **Build infinite scroll feed** (intersection observer, pagination, loading, scroll restoration)
6. **Multi-step wizard with complex validation** (conditional fields, cross-field validation, save progress)
7. **State management scenario** (global vs. local, context vs. stores, cache invalidation)
8. **Performance optimization challenge** (fix slow-rendering component, reduce bundle, optimize re-renders)
9. **Build notification/toast system** (queue management, auto-dismiss, stacking, accessibility)

## Phase Structure
Format: **Live coding** (60-90 min) or **take-home** (4-8 hours) with follow-up
- **Requirements & scope (5-10 min):** Clarify functional/non-functional, define MVP vs. stretch
- **Architecture planning (10-15 min):** Component tree, state management strategy, API contracts
- **Core implementation (30-40 min):** Primary feature with proper decomposition
- **Enhancement & optimization (15-20 min):** Edge cases, performance, accessibility
- **Discussion & trade-offs (15-20 min):** Architectural decisions, scaling, alternatives

## What Makes This Level Unique
- Must demonstrate **architectural thinking**, not just implementation
- Interviewers expect **state management trade-off discussion** (Context vs. Redux vs. Zustand vs. React Query)
- **Performance awareness mandatory**: re-renders, memo, virtualization, debouncing
- Must handle **real-time data patterns**: WebSockets, SSE, polling trade-offs
- Code shows **reusable, composable component design** with clear prop APIs
- Expected to discuss **testing strategy** (unit vs. integration test)

## Common Problems/Scenarios
- Searchable, sortable data table with pagination and virtual scroll
- Real-time analytics dashboard updating via WebSocket
- Kanban board with drag-and-drop (Trello-like)
- Autocomplete with debounced API calls and result caching
- Infinite-scroll social feed with optimistic updates
- File upload with progress, preview, error handling
- Calendar/date picker with range selection
- Configurable form builder (dynamic fields from config)

## Anti-Patterns (do NOT expect at this level)
- Choosing state management without justification
- Ignoring rendering performance (no memo, no virtualization for large lists)
- Monolithic 500-line components
- Not discussing trade-offs (only one solution, no alternatives)
- Premature optimization before identifying bottlenecks
- Happy-path-only implementations (no error boundaries, recovery)
- Not considering offline/degraded states

## Probe Patterns
- "How would this perform with 100,000 rows?"
- "WebSocket connection drops — how recover?"
- "How would you test this component?"
- "If reusing in another app, what would you change?"
- "Trade-offs between polling and WebSockets here?"
- "Two users edit same item simultaneously?"

## Sources
- Frontend System Design Handbook
- GreatFrontEnd System Design Playbook
- Frontend Case Studies (GitHub)
- FrontendLead — Frontend System Design Interview Guide
