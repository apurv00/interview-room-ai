# Frontend Engineer — Coding Interview — Entry Level (0-2 years)

## Problem Types
- **JavaScript Fundamentals (40%):** var/let/const, hoisting, scope, closures, `this` binding, output prediction (event loop, promises, prototype chain), array methods (map, filter, reduce)
- **DOM Manipulation (20%):** querySelector, event listeners, event bubbling/capturing, event delegation, form validation, creating/removing elements
- **CSS Layout & Styling (15%):** Box model, Flexbox basics, display values, positioning, responsive media queries, specificity
- **Simple UI Component Building (15%):** Counter app, to-do list, toggle theme, basic form, accordion/tabs, star rating, traffic light
- **Basic Algorithms (10%):** String reversal, palindrome check, array dedup, FizzBuzz, object manipulation

## Difficulty Level
- **Easy: 70% | Medium: 25% | Hard: 5%**
- Core JS concepts, basic DOM, simple CSS layouts dominate

## Phase Structure
**Format A: Live Coding (30-45 min)**
1. Warm-up (5 min) — Introductions
2. JS Fundamentals (10-15 min) — 1-2 output prediction or concept questions
3. Coding Task (15-20 min) — Build small component or DOM problem
4. Q&A (5 min)

**Format B: Take-Home (1-3 hours)**
- Build small web app (fetch data, display list, add filtering)
- Followed by 30-min review call: walk through code and extend it

## What Makes This Level Unique
- Questions heavily weighted toward **language fundamentals** — proof of actual JS understanding, not framework magic
- CSS questions are about **can you center a div** or **explain box model**, not complex layouts
- Component tasks intentionally simple — evaluation is on clean code, not architecture
- **Take-home projects more common** at this level than senior
- Forgiving about framework internals, unforgiving about `let` vs `var` or what a closure is
- **No system design expected**

## Evaluation Criteria
| Dimension | Weight |
|-----------|--------|
| JavaScript Knowledge | 30% |
| Working Solution | 25% |
| Code Readability | 20% |
| Communication | 15% |
| Edge Case Awareness | 10% |

## Common Frontend-Specific Problems
**JavaScript:** Output of `for(var i=0; i<3; i++){setTimeout(()=>console.log(i),0)}`, implement Array.prototype.map, flatten nested array, remove duplicates, basic debounce
**DOM:** Counter with +/- buttons, form with email/password validation, to-do list, character countdown textarea, traffic light cycle
**CSS:** Center div with Flexbox, responsive two-column layout, fixed navbar, z-index explanation, button hover/active/focus states

## Anti-Patterns (do NOT expect)
- Using `var` everywhere instead of `let`/`const`
- Can't explain `this` in context
- Copy-pasting patterns without understanding
- Not handling null/empty input
- All logic in single function
- innerHTML for everything
- Ignoring accessibility (no labels, no semantic HTML)
- Coding immediately without planning

## Sources
- Front End Interview Handbook 2026
- GreatFrontEnd Top JavaScript Interview Questions
- Frontend Machine Coding Questions (GitHub)
- 35 Vanilla JS Machine Coding Challenges (GitHub)
- CoderPad Frontend Interview Questions
