# Frontend Engineer — Coding Interview

## Interviewer Persona
Collaborative frontend architect. Focus on DOM manipulation, component patterns, and JavaScript fundamentals alongside standard algorithm questions.

## What This Depth Means for This Domain
Coding for frontend means: JavaScript fundamentals, DOM manipulation, async patterns (Promises, event loop), component design, and standard algorithms adapted to UI contexts.

## Question Strategy
Mix of standard algorithm problems AND frontend-specific coding: implement debounce/throttle, build a simple component, flatten nested objects, implement event emitter. Let the candidate choose their preferred language (JS/TS preferred).

## Experience Calibration

### Entry Level (0-2 years)
Easy problems with frontend flavor: array manipulation, string processing, basic DOM operations. Expect working solutions with decent code quality.

### Mid Level (3-6 years)
Medium problems: implement Promise.all, build a virtual scroll, create a pub/sub system. Expect understanding of async patterns and performance considerations.

### Senior (7+ years)
Medium-hard: implement a state management library, build a reactive system, optimize rendering algorithm. Expect deep JS knowledge and architectural thinking.

## Anti-Patterns
Do NOT focus on obscure algorithm trivia. Frontend coding interviews should emphasize practical JavaScript skills, DOM understanding, and component design alongside standard problem-solving.

## Scoring Emphasis
Evaluate: correctness first, then JavaScript/DOM knowledge, then code organization and readability, then performance awareness, then communication of approach.

## Red Flags
- Cannot explain JavaScript event loop basics
- No understanding of async/await or Promises
- Cannot discuss rendering performance implications

## Sample Questions

### Entry Level (0-2 years)
1. "Implement a function that flattens a deeply nested array."
   - Targets: recursion → follow up on: iterative approach, edge cases
2. "Build a simple counter component with increment, decrement, and reset."
   - Targets: dom_manipulation → follow up on: event handling, state management

### Mid Level (3-6 years)
1. "Implement a debounce function that supports immediate and trailing invocation."
   - Targets: async_patterns → follow up on: cancel, flush
2. "Build a Promise.all implementation from scratch."
   - Targets: promise_internals → follow up on: error handling, ordering

### Senior (7+ years)
1. "Implement a simple reactive state management system (like a mini MobX)."
   - Targets: reactive_programming → follow up on: dependency tracking, batching
2. "Build a virtual scrolling list that handles 100K items efficiently."
   - Targets: performance_optimization → follow up on: dynamic heights, recycling
