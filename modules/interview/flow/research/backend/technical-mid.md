# Backend Engineer — Technical Interview — Mid Level (3-6 years)

## Topic Sequence (typical order)
1. **System design fundamentals** — Design a URL shortener, rate limiter, or real-time chat. Requirements gathering, high-level architecture, component selection.
2. **Database design and optimization** — Schema design, indexing strategies, SQL vs. NoSQL trade-offs, query optimization, normalization/denormalization.
3. **API design** — REST best practices, API versioning, pagination, error handling, authentication (JWT, OAuth2), gRPC fundamentals.
4. **Caching strategies** — Cache layers (CDN, application, database), invalidation patterns, Redis/Memcached use cases, cache-aside vs. write-through.
5. **Algorithms and data structures (medium-hard)** — Graph algorithms, dynamic programming, tree operations, advanced string manipulation. 15 core patterns to master.
6. **Concurrency and multithreading basics** — Thread safety, race conditions, locks vs. semaphores, async/await patterns, connection pooling.
7. **Message queues and async processing** — Kafka, RabbitMQ, SQS use cases. Event-driven architecture basics. Producer-consumer patterns.
8. **Microservices fundamentals** — Service boundaries, inter-service communication (sync vs. async), API gateway, service discovery, database-per-service.
9. **Scalability concepts** — Horizontal vs. vertical scaling, load balancing, database replication (read replicas), basic sharding.
10. **Operational concerns** — Monitoring, logging, basic CI/CD, deployment strategies (blue-green, canary), error budgets.

## Phase Structure
- **System design round (45-60 min):** Open-ended problem. 5 min requirements, 10 min high-level design, 20 min component deep-dive, 10 min scalability/trade-offs. Interviewer may change requirements mid-discussion.
- **Coding round (45-60 min):** 1-2 medium-to-hard algorithm problems. May include practical backend problem (fix a broken API, optimize a DB query).
- **Technical knowledge round (30-45 min):** Deep Q&A on databases, caching, APIs, concurrency. Tests trade-off understanding, not definitions.
- **Recommended prep split:** 50% coding, 25% system design, 25% behavioral.

## What Makes This Level Unique
- **System design is now a distinct round.** Key difference from entry level. Scope bounded to single service or feature.
- **Trade-off reasoning is critical.** Must explain "why this over that" — consistency vs. availability, latency vs. throughput, normalization vs. denormalization.
- **Practical backend challenges replace pure algorithm puzzles at some companies.** Fix a broken API, optimize a slow query instead of inverting a binary tree.
- **Interviewer changes requirements mid-interview** to test adaptability — "Now assume traffic increases 100x."
- **Production experience expected.** Answers should reference real systems, not textbook knowledge.
- **Algorithms shift from easy-medium to medium-hard.** Pattern recognition matters more than memorization.

## Anti-Patterns (do NOT ask at this level)
- Organizational-level architecture decisions (senior/staff scope)
- Cross-cutting concerns affecting 5+ teams
- Build-vs-buy decisions at organizational level
- Legacy system migration spanning multiple domains
- Multi-region, multi-datacenter reasoning (staff+ scope)
- Problems solvable with simple CRUD (too basic)

## Probe Patterns
- **Deep follow-up:** System design (drill into components — "How does cache invalidation work exactly?", "What if this node fails?", "Walk me through the write path"), database optimization (execution plan reasoning, index selection)
- **Moderate depth:** Caching (trade-offs, not just "use Redis"), microservices (when NOT to use them), concurrency (practical experience, not textbook)
- **Surface treatment:** CI/CD (awareness), monitoring (what metrics matter), deployment strategies (conceptual)
- **Requirement-change probes:** Unique to mid-level — interviewer shifts constraints during system design

## Sources
- Interviewing.io — Senior Engineer's Guide to System Design
- System Design Handbook — Complete Interview Guide 2026
- Tech Interview Handbook — System Design Guide
- Hackajob — Backend Developer Interview Preparation Guide 2025
- Underdog.io — Reality of Tech Interviews in 2025
- Monzo — Demystifying the Backend Engineering Interview Process
