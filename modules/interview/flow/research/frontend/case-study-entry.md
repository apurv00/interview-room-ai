# Frontend Engineer — Case Study Interview — Entry Level (0-2 years)

## Topic Sequence (typical order)
1. **Build a UI component from a design spec** (accordion, tabs, star rating, modal)
2. **Implement a small interactive feature** (todo list with CRUD, counter with undo, toggle theme)
3. **Fix and improve a broken component** (CSS layout bugs, broken event handlers, accessibility issues)
4. **Form with validation** (multi-field, real-time validation, error messages, submit handling)
5. **Fetch and display data from an API** (loading states, error handling, empty states)
6. **Responsive layout implementation** (mobile-first, flexbox/grid, breakpoints)
7. **Basic state management scenario** (shopping cart add/remove, filter/sort a list)
8. **Pixel-perfect UI from Figma/design mockup** (spacing, typography, colors)

## Phase Structure
Format: Typically **take-home project** (2-4 hours) or **live machine coding** (45-60 min)
- **Requirements reading (5 min):** Read spec, identify edge cases
- **Planning (5-10 min):** Component decomposition, identify state needs
- **Implementation (30-45 min):** Build working feature
- **Polish & edge cases (10-15 min):** Error states, loading, responsiveness
- **Walkthrough/review (10-15 min):** Explain decisions, discuss improvements

## What Makes This Level Unique
- System design is **rarely asked** — focus is on implementation ability
- Tests **HTML/CSS/JS fundamentals** over framework expertise
- The "case study" is really a **practical coding challenge** with realistic scenario
- Emphasis on **clean code, semantic HTML, and basic accessibility** (aria-labels, keyboard nav)
- Expected to handle basic state but not complex architecture

## Common Problems/Scenarios
- Build an interactive rating component (stars, hover preview)
- Create a todo app with add/delete/edit/filter
- Implement accordion or tabs from scratch
- Build responsive card layout fetching from REST API
- Multi-step form with validation
- Searchable/filterable list component
- Image carousel with navigation controls
- Counter with increment, decrement, reset, undo

## Anti-Patterns (do NOT expect at this level)
- Not asking clarifying questions before coding
- Ignoring edge cases: empty states, loading, errors
- Everything in one component with no decomposition
- No semantic HTML, keyboard nav, or aria attributes
- Over-engineering with Redux for a simple todo
- Hardcoded values, no responsive breakpoints

## Probe Patterns
- "How would you make this accessible for screen readers?"
- "What happens if the API call fails?"
- "How would you handle the empty state?"
- "Can you make this work on mobile?"
- "What if the list had 10,000 items?"

## Sources
- Frontend Interview Handbook 2026
- GreatFrontEnd Machine Coding Questions
- Frontend Mentor Challenges
- freeCodeCamp — Interview Questions for Junior Front End Developers
