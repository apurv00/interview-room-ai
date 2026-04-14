# Backend Engineer — Coding Interview — Senior Level (7+ years)

## Problem Types
- **Graphs:** Complex algorithms (Dijkstra, union-find, network flow concepts)
- **Dynamic Programming:** Multi-dimensional DP, optimization with constraints
- **Trees:** Advanced problems (segment trees, trie-based solutions)
- **System-Oriented Coding:** Implement distributed-style components (consistent hashing, gossip protocol sketch, event sourcing)
- **Concurrency & Parallelism:** Lock-free data structures, concurrent task execution, producer-consumer with back-pressure
- **Design-in-Code:** Given a vague problem, architect class hierarchy/interfaces AND implement core logic
- **Data Processing:** Stream processing, batch pipeline logic, data partitioning strategies

## Difficulty Level
- **Easy: 0-5% | Medium: 55-65% | Hard: 25-35%**
- Medium problems remain the core even at senior level, but expectations for code quality and depth are much higher
- Hard problems appear but difficulty is measured differently — handling ambiguity, edge cases, trade-offs, and producing production-quality code matters more than algorithmic tricks
- System design and behavioral carry **equal or greater weight** than coding at this level

## Phase Structure (45-60 minutes)
1. **Problem Intro (1-2 min):** Deliberately vague; testing whether you ask the right questions
2. **Requirements Gathering (5-8 min):** Candidate drives; define scope, constraints, success criteria
3. **Architecture/Approach (7-10 min):** 2-3 approaches with detailed trade-off analysis; discuss scalability, failure modes, maintainability; justify choice
4. **Coding (15-20 min):** Production-quality: error handling, input validation, clean abstractions, proper naming
5. **Testing & Edge Cases (5-7 min):** Comprehensive strategy; non-obvious edge cases; discuss production testing
6. **Extension & Optimization (5-10 min):** How to scale? Requirements change? How to monitor in production?

## What Makes This Level Unique
- **Reasoning globally, not locally:** Think in abstractions, constraints, trade-offs, and long-term consequences
- **Design within code:** Even in "coding" round, expected to architect before implementing; class design, interface boundaries, separation of concerns
- **Trade-off articulation is mandatory:** latency vs. accuracy, consistency vs. availability, cost vs. scale; a silent correct solution scores worse than communicative near-optimal one
- **Staff/Principal distinction:** Staff = quarters-to-years thinking; Principal = organization-wide direction
- **Coding round is deemphasized** relative to system design and behavioral — many Staff+ engineers write less code in interviews
- **Code review as alternative format** — some companies have seniors review existing code rather than write new code

## Evaluation Criteria
1. **Problem Solving:** Drives requirements; considers non-obvious constraints; systematic multi-dimensional trade-off analysis
2. **Communication:** Leads conversation; explains "why" not just "what"; discusses alternatives proactively
3. **Technical Competency:** Production-quality code; strong abstractions; handles concurrency and failure
4. **Testing:** Comprehensive including edge cases, failure scenarios, performance testing approach
5. **Architectural Judgment:** Clean separation of concerns; extensible design; appropriate trade-offs
6. **Scalability & Production:** Monitoring, observability, deployment considerations; behavior under load
7. **Leadership Signal (Staff+):** Can they own the entire problem space? Org implications considered?

## Anti-Patterns (do NOT expect at this level)
- Pure algorithmic trick questions with no practical application
- Evaluated primarily on coding speed
- Getting away with "just working" code lacking error handling or structure
- Ignoring non-functional requirements (performance, reliability, observability)
- Treating this as "harder LeetCode" — fundamentally different evaluation (design + code + communication)

## Common Backend-Specific Problems
- **Design and implement a URL shortener** end-to-end (hashing, collision handling, caching with Redis, analytics)
- **Build a web crawler** with pipelining, retry with exponential backoff, URL deduplication
- **Implement consistent hashing** for a distributed cache
- **Design and code a task scheduler** with priorities, dependencies, failure handling
- **Build an event-driven pipeline** (producer-consumer with back-pressure)
- **Implement a key-value store** with TTL, eviction policies, concurrent access
- **Design a distributed rate limiter** (sliding window + Redis)
- **LeetCode Hard examples:** Median of Two Sorted Arrays, Trapping Rain Water, Word Ladder II, Alien Dictionary

## Sources
- Prepfully — Meta Senior vs Staff Engineer Interview Expectations
- Medium — Senior Engineer Interviews 2025-2026: What Actually Decides Your Offer
- Underdog.io — The Reality of Tech Interviews in 2025
- Medium — 10 LeetCode Problems That Challenge Senior Engineers
- DEV Community — Guide to Ace System Design: Junior vs Senior
- Recruiter.daily.dev — Hiring Staff Engineers: The Complete Guide
