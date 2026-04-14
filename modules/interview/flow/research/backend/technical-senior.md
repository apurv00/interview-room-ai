# Backend Engineer — Technical Interview — Senior Level (7+ years)

## Topic Sequence (typical order)
1. **Large-scale system design** — Design a system handling millions of concurrent users (collaborative editing, real-time analytics, large-scale search). Multi-service, multi-database architectures.
2. **Distributed systems deep-dive** — CAP theorem applied to real scenarios, consistency models (strong, eventual, causal), consensus algorithms (Paxos, Raft), distributed transactions (saga, 2PC).
3. **Database internals and advanced optimization** — B-tree and LSM-tree internals, query execution plans, advanced indexing (composite, partial, covering), sharding strategies, replication topologies.
4. **Architecture evaluation and tech strategy** — Build vs. buy assessment, legacy modernization (strangler pattern), migration planning, technology selection frameworks, total cost of ownership.
5. **Cross-cutting concerns at scale** — Observability (distributed tracing, metrics, logging), security architecture, API gateway design, service mesh, rate limiting and backpressure.
6. **Advanced concurrency and performance** — Lock-free data structures, event loops, connection pooling optimization, GC tuning, memory management, profiling production systems.
7. **Reliability engineering** — Failover strategies, chaos engineering, circuit breakers, bulkhead patterns, SLO/SLI/SLA definition, capacity planning, disaster recovery.
8. **Architecture presentation / project deep-dive** — Present a system you designed: 2 technical and 2 organizational challenges. Interviewers probe trade-offs and what you'd do differently.
9. **Code review and API design review** — Review a PR or API specification. Tests judgment, communication, and ability to identify systemic issues.
10. **Technical mentorship and standards** — How you've established coding standards, review practices, ADRs, or technical onboarding programs.

## Phase Structure
- **System design round (60 min):** Significantly more open-ended. Candidate drives conversation, identifies requirements proactively, considers 3-5 year evolution. The most heavily weighted component of the interview.
- **Architecture presentation / tech talk (45-60 min):** Candidate presents past project architecture. Panelists (other senior/staff engineers) ask probing questions.
- **Coding round (30-45 min):** Shorter and less weighted. May be code review instead of greenfield coding. Coding is baseline, not differentiator.
- **Technical strategy discussion (30-45 min):** Technology evaluation, direction-setting, consensus building. Build-vs-buy, migration strategies, organizational technical debt.
- **Recommended prep split:** 50% system design, 20% coding, 30% behavioral.

## What Makes This Level Unique
- **System design is the most heavily weighted component.** At Staff+, coding is baseline — differentiation comes from system design + behavioral/leadership.
- **Architecture presentation is a distinct interview format** not seen at lower levels. Some companies ask candidates to give a "tech talk" on a past system.
- **Scope extends beyond single services to organizational architecture.** Cross-service, cross-team, cross-domain systems.
- **Technology strategy is explicitly assessed.** Build vs. buy, legacy modernization, migration planning, tech debt prioritization.
- **3-5 year forward-looking reasoning.** Must think beyond current requirements.
- **Code review as interview format** emerges — judgment about code matters as much as producing it.
- **Coding round is deemphasized.** Greater focus on system design than coding at on-site. Some interviews involve pure discussion with no code written.

## Anti-Patterns (do NOT ask at this level)
- LeetCode-style algorithmic puzzles as primary evaluation (wrong signal)
- Basic system design problems solvable in 15 minutes (URL shortener too simple)
- Questions testable with textbook definitions (must require production experience)
- Purely individual coding without architectural context
- Questions that don't require multi-team reasoning
- Technology trivia ("What port does Redis use?") instead of strategic evaluation
- Problems with a single "right answer" — senior interviews should be open-ended

## Probe Patterns
- **Deep follow-up:** System design (failure modes — "What if X goes down?", "Walk through a cascading failure"), architecture presentation (challenge decisions — "Why not X instead?", "How would you handle differently today?"), tech strategy (multi-stakeholder consensus building)
- **Moderate depth:** Coding (verify baseline, discuss design patterns), observability (real examples of instrumentation)
- **Surface treatment:** Basic data structures (assumed), individual tool choices (less important than systemic reasoning)
- **Unique probes:** "Tell me about a system you'd design differently today", "Explain this architecture to a new team member vs. a CTO", "What's the biggest technical bet you got wrong?"

## Sources
- StaffEng — Interviewing for Staff-plus Roles
- Interviewing.io — Senior Engineer's Guide to System Design
- GeeksforGeeks — System Design Interview Guide for Senior Engineers
- Daily.dev Recruiter — Hiring Principal Engineers Guide
- Onsites.fyi — Google L6 Interview Guide
- Prepfully — Meta Senior vs Staff Engineer Interview Expectations
