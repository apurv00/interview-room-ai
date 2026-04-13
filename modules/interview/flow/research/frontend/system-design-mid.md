# Frontend Engineer — System Design Interview — Mid Level (3-6 years)

## Topic Sequence (using RADIO framework: Requirements, Architecture, Data Model, Interface, Optimization)
1. **Design an autocomplete/typeahead** (debouncing, caching, keyboard nav, API, accessibility)
2. **Design a news feed** (infinite scroll, virtualization, pagination, optimistic updates, skeletons)
3. **Design an image gallery/Pinterest grid** (masonry layout, lazy loading, responsive images, lightbox)
4. **Design a chat application** (real-time messaging, WebSocket architecture, history, typing indicators)
5. **Design a video player** (playback controls, buffering, quality selection, captions, keyboard shortcuts)
6. **Design an e-commerce product page** (product data, cart state, reviews, SEO)
7. **Design a notification system** (real-time push, toast queue, persistence, read/unread state)
8. **Design a data table/grid** (sorting, filtering, pagination, column resize, virtual scroll, export)
9. **Design a poll/survey widget** (real-time results, vote tracking, animations, embed API)
10. **Design a multi-step form/wizard** (validation, progress persistence, conditional steps)

## Phase Structure (RADIO framework, 35-45 min dedicated round)
- **Requirements (R) (5 min):** Scope, functional/non-functional, constraints (mobile? offline? SEO?)
- **Architecture (A) (8-10 min):** Component hierarchy, key boundaries, routing, rendering (CSR/SSR/SSG)
- **Data Model (D) (8-10 min):** Client-side state shape, server contracts, caching, state management approach
- **Interface (I) (8-10 min):** Component API (props), REST/GraphQL endpoints, event handling, real-time protocols
- **Optimization (O) (8-10 min):** Performance (lazy loading, code splitting, virtualization), accessibility, error handling, monitoring

## What Makes This Level Unique
- **Core system design round** — dedicated 35-45 min slot
- Must demonstrate **RADIO framework** or equivalent structured approach
- Expected to discuss **rendering strategies** (CSR vs. SSR vs. SSG vs. ISR) with scenario-specific trade-offs
- Must handle **real-time patterns**: WebSocket vs. SSE vs. long polling with clear reasoning
- **Caching strategies essential**: HTTP cache, in-memory, React Query/SWR, IndexedDB
- Should discuss **accessibility proactively** (ARIA, keyboard nav, focus management)
- Must draw **component hierarchy diagrams** with data flow
- Must discuss **error handling** beyond happy path (network failures, race conditions, stale data)

## Common Problems/Scenarios
- "Design frontend for Twitter's timeline feed"
- "Design autocomplete search like Google's"
- "Design frontend for Airbnb listing page with search and filters"
- "Design real-time chat like Slack"
- "Design video player like YouTube"
- "Design collaborative kanban board like Trello"
- "Design photo sharing app like Instagram"
- "Design music player like Spotify web"
- "Design ride-sharing map interface like Uber"
- "Design email client like Gmail"

## Anti-Patterns (do NOT expect at this level)
- Starting with framework choice before understanding requirements
- Over-engineering the backend (databases, message queues) in a frontend interview
- No component diagram (only verbal)
- Ignoring accessibility entirely
- One-size-fits-all state management regardless of complexity
- One solution as "the best" without alternatives
- 20 min on data model, 5 min on everything else
- Being defensive when interviewer pushes back

## Probe Patterns
- "Support offline mode — how does architecture change?"
- "10M concurrent users viewing this feed?"
- "User on 3G connection — how optimize?"
- "Walk through every step when user types a character in search"
- "How implement undo/redo?"
- "Cache invalidation strategy — how know when data is stale?"
- "How test this system? What would you mock?"
- "Core Web Vitals implications of your rendering choice?"
- "How handle internationalization (i18n)?"
- "Migrate from CSR to SSR — what changes?"

## Sources
- FrontendGeek — 21 Most Asked Frontend System Design Questions
- GreatFrontEnd — System Design Questions
- Frontend Interview Handbook — Applications
- RADIO Framework (GreatFrontEnd)
- GreatFrontEnd — Evaluation Axes
