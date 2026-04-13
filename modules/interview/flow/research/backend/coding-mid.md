# Backend Engineer — Coding Interview — Mid Level (3-6 years)

## Problem Types
- **Arrays & Strings:** Sliding window, prefix sums, interval merging
- **Hash Tables:** Complex lookups, grouping, caching patterns
- **Trees & Graphs:** BFS/DFS, shortest path, topological sort, tree serialization
- **Dynamic Programming:** 1D and 2D DP (knapsack, longest subsequence)
- **Linked Lists:** Advanced manipulation (merge k lists, copy with random pointer)
- **Stacks/Queues/Heaps:** Priority queues, monotonic stacks, min/max heaps
- **Backend/System-Oriented:** LRU cache, rate limiter, task scheduler, simple message queue, CRUD service with error handling
- **Concurrency:** Basic thread safety, producer-consumer patterns

## Difficulty Level
- **Easy: 10-15% | Medium: 65-75% | Hard: 15-20%**
- Medium problems are the core; must solve cleanly without hints
- Hard problems appear as follow-ups ("now scale this")
- Recommended prep: 50% coding, 25% system design, 25% behavioral

## Phase Structure (45 minutes)
1. **Problem Intro (2 min):** More ambiguous than junior-level; less hand-holding
2. **Clarification (3-5 min):** Expected to identify edge cases and constraints proactively
3. **Approach Discussion (5-7 min):** Multiple approaches with trade-off analysis; state Big-O for each
4. **Coding (15-20 min):** Clean, well-structured implementation; proper naming, modular functions
5. **Testing (5-7 min):** Must test corner cases unprompted (empty input, overflow, duplicates)
6. **Optimization & Follow-ups (5-10 min):** Scaling, concurrency, production-readiness

## What Makes This Level Unique
- Interviewers assess **engineering judgment**, not just correctness
- **Code quality matters:** readability, maintainability, modularity evaluated
- Expected to discuss **testing strategy** without being prompted
- Must demonstrate **ownership:** debugging instincts, incident awareness, ability to improve systems
- **Production concerns surface:** observability (logging, metrics), error handling, structured responses
- **82% of companies** now expect flawless implementation with error handling in same time limits

## Evaluation Criteria
1. **Problem Solving:** Multiple approaches with trade-off analysis; correct Big-O; systematic decomposition
2. **Communication:** Proactive clarification, structured explanation, thinking aloud naturally
3. **Technical Competency:** Clean, correct code; strong language mastery; handles edge cases
4. **Testing:** Self-driven testing of normal AND corner cases; self-corrects bugs
5. **Code Quality:** DRY, modular, readable; proper error handling; testable structure
6. **Engineering Depth:** Production implications (latency, reliability, observability)

## Anti-Patterns (do NOT expect at this level)
- Pure LeetCode Hard without practical/system context
- Evaluated purely on speed (communication and quality matter more)
- Ignoring code quality for "just make it work"
- No system design component (some coding rounds blend into mini-design)
- Getting away without discussing complexity trade-offs

## Common Backend-Specific Problems
- **LRU Cache:** O(1) get/put with hashmap + doubly-linked list
- **Rate Limiter:** Token bucket or sliding window implementation
- **Task Scheduler:** Greedy with cooldown reasoning
- **Serialize/Deserialize** a data structure (tree, graph)
- **Connection pool** or simple thread-safe cache
- **Merge Intervals, Top K Frequent Elements** (heap)
- **Word Search / Course Schedule** (graph DFS/BFS, topological sort)

## Sources
- Hackajob — Backend Developer Interview Preparation Guide 2025
- Underdog.io — The Reality of Tech Interviews in 2025
- Educative — Mid-Level Software Engineer Interview Questions
- Tech Interview Handbook — Coding Interview Rubrics
- Interviewing.io — LRU Cache Interview Solution
