# Frontend Engineer — System Design Interview — Entry Level (0-2 years)

## Topic Sequence (typical order)
1. **Component decomposition of a given UI** (break mockup into component tree)
2. **Basic state flow for a feature** (where state lives, how props flow)
3. **Simple data fetching pattern** (fetch from API, loading/error/success display)
4. **Form component with state management** (controlled vs. uncontrolled, validation)
5. **Routing and page layout** (how pages relate, shared layouts, navigation)
6. **Basic client-side caching concept** (when to re-fetch, stale data, localStorage)
7. **Simple rendering strategy discussion** (CSR vs. SSR at a basic level)

## Phase Structure
Format: Usually part of a **broader technical interview** (15-25 min portion), NOT a dedicated round
- **Problem statement (2-3 min):** Simple UI — "Design the frontend for a weather app"
- **Component breakdown (5-8 min):** Draw/describe component tree, identify data needs
- **State and data flow (5-8 min):** Where state lives, component communication, API calls
- **Basic considerations (5 min):** Responsiveness, loading states, error handling

## What Makes This Level Unique
- System design is **often not asked at all** for juniors; if asked, expectations are very low
- Really about **component thinking**, not architecture
- Want to see you can **decompose a UI into logical components**
- Understanding **props vs. state** and **parent-child communication** is sufficient
- No expectation of caching strategies, service workers, or advanced optimization
- **Basic accessibility awareness** (semantic elements, alt text) is a bonus

## Common Problems/Scenarios
- "Structure components for a weather app"
- "Design component tree for simple e-commerce product page"
- "Build frontend for basic chat interface"
- "Break down this todo app mockup into React components"
- "Design a simple profile page with editable fields"
- "Structure a blog post page with comments"

## Anti-Patterns (do NOT expect at this level)
- Proposing micro-frontends or complex state management for simple app
- Jumping to code without visual component decomposition
- Flat structure (everything in one giant component)
- Confusing client and server concerns
- Not identifying reusable components
- Silence (not explaining reasoning)

## Probe Patterns
- "Which component owns this state and why?"
- "How do header and product list communicate?"
- "User clicks 'Add to Cart' — walk through data flow"
- "How show loading spinner while fetching?"
- "If needed on mobile, what changes?"

## Sources
- Frontend Interview Handbook — System Design Overview
- System Design Handbook — Frontend Interview Guide
- Awesome Frontend System Design (GitHub)
- GreatFrontEnd RADIO Framework
