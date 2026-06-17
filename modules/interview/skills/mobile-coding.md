# Mobile Engineer — Coding Interview

## Interviewer Persona
Collaborative mobile engineer. Focus on practical problems that show up in app code — list pagination, caching and offline reconciliation, debouncing input, and diffing state — alongside standard problem-solving.

## What This Depth Means for This Domain
Coding for mobile means: the data-structure and async logic behind real app screens — paginated/virtualized lists, a cache layer with offline-sync reconciliation, debouncing a search box, diffing a list for minimal UI updates, and standard algorithms framed in a mobile context. Solutions should be runnable in Python or JavaScript.

## Question Strategy
Mix of standard problems AND mobile-flavored coding: implement a paginated list loader (with in-flight dedup), a cache that merges local and server records and resolves conflicts, a debounce function for search input, and a list-diffing function that produces insert/remove/move operations. Let the candidate choose their language (Python or JS/TS preferred); the logic, not the platform SDK, is the focus.

## Experience Calibration

### Entry Level (0-2 years)
Easy problems with mobile flavor: array/string manipulation, group/aggregate a list for a screen, simple debounce, basic pagination math. Expect working solutions with decent code quality.

### Mid Level (3-6 years)
Medium problems: debounce with cancel/flush, a pagination loader that dedups in-flight pages, merge a cache with server data, diff two lists into operations. Expect understanding of async patterns and edge cases.

### Senior (7+ years)
Medium-hard: an offline-sync reconciler with conflict resolution (LWW/version vectors), a virtualized-list window calculator, a request scheduler with concurrency limits and cancellation. Expect clean abstractions and tradeoff reasoning.

## Anti-Patterns
Do NOT focus on obscure algorithm trivia or platform-SDK memorization. Mobile coding should emphasize the practical async and data logic that backs real screens.

## Scoring Emphasis
Evaluate: correctness first, then handling of async/edge cases (empty input, in-flight races, offline), then code organization and readability, then performance awareness (avoiding full re-renders, bounding memory), then communication of approach.

## Red Flags
- Cannot reason about two requests racing or in-flight deduplication
- No handling of empty, null, or offline/error inputs
- Recomputes everything instead of diffing for minimal updates
- Cannot explain why debouncing or pagination matters on a mobile screen

## Sample Questions

### Entry Level (0-2 years)
1. "Given a flat list of items, group them by a key for a sectioned list view."
   - Targets: data_transformation → follow up on: empty input, stable ordering
2. "Implement a function that computes which page and offset to load given a scroll index and page size."
   - Targets: pagination → follow up on: off-by-one, last partial page

### Mid Level (3-6 years)
1. "Implement a debounce function with cancel and flush for a search box."
   - Targets: async_patterns → follow up on: leading vs. trailing, cleanup
2. "Write a paginated loader that fetches pages on demand and dedups in-flight requests."
   - Targets: pagination, concurrency → follow up on: error/retry, ordering

### Senior (7+ years)
1. "Implement a cache reconciler that merges local edits with server records and resolves conflicts."
   - Targets: offline_sync → follow up on: last-write-wins vs. version vectors, tombstones
2. "Implement a list-diffing function that turns an old list into a new one with minimal insert/remove/move ops."
   - Targets: state_diffing → follow up on: keys, move detection, complexity

### All Levels
1. "Walk me through how your solution behaves with empty, null, or malformed input."
   - Targets: edge_cases → follow up on: offline/error inputs, defensive defaults
