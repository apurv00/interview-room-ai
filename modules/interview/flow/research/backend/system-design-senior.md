# Backend Engineer — System Design Interview — Senior Level (7+ years)

## Topic Sequence (typical order)
1. **Ambiguous requirement clarification and scope definition** (candidate-driven)
2. **Scale estimation and constraint identification**
3. **High-level architecture with multiple services, data stores, and communication patterns**
4. **Deep-dive into 2-3 critical components** with implementation-level detail
5. **Data consistency models and distributed systems trade-offs** (CAP, PACELC)
6. **Failure modes, fault tolerance, and disaster recovery**
7. **Multi-region deployment and global data replication**
8. **Operational concerns:** monitoring, alerting, SLOs, on-call implications
9. **System evolution:** how design changes over time, tech debt management
10. **Cost optimization and infrastructure efficiency**

## Phase Structure
Interview is **fully candidate-led**:
- **Vague Problem Statement (2-3 min):** Deliberately broad — "Design YouTube" or "Design a distributed locking service." Minimal constraints.
- **Scope Definition & Requirements (5-10 min):** Candidate drives requirements discussion, identifies functional and non-functional requirements, makes trade-off decisions (e.g., "I'll prioritize availability over consistency because...").
- **Architecture Design (10-15 min):** Comprehensive high-level design quickly — should "speed through" to leave time for deep dives.
- **Deep Dives (15-20 min):** Where senior interviews are won or lost. Must go deep on 2-3 components with implementation-level understanding. E.g., for ride-sharing: geospatial indexing, ride-request locking, dispatch queuing.
- **Failure & Evolution (5-10 min):** "What when Region A goes down?", "How does this change at 50x traffic in 3 years?"

## What Makes This Level Unique
- Evaluation: **"Can this person independently own a system?"** and for Staff+: **"shape the organization?"**
- Candidate **leads** and remains **collaborative** while driving direction.
- Must **choose trade-offs**, not just identify them. "As a junior you may identify where the trade-off is, but as a senior you must choose, justify, and highlight techniques to materialize it."
- Must consider **all aspects**: scalability, consistency, partition tolerance, availability, fault tolerance, security, maintainability.
- Expected to have **in-depth distributed systems knowledge**.
- Must demonstrate **flexibility** when requirements change — "even strong initial designs fail if candidate cannot pivot."
- Discussions go **beyond forecasted requirements** — unforeseen problems, system longevity.
- Must effectively use **feedback** to make design changes mid-interview.

## Common Problems/Scenarios Given
- **YouTube/Netflix:** Video upload pipeline (multi-quality encoding), streaming via CDN, recommendations, comments, subscriptions.
- **Ride-Sharing (Uber/Lyft):** Geospatial indexing, nearest-neighbor search, real-time matching/dispatch, dynamic pricing, driver-rider locking.
- **Distributed Locking Service:** Safety (mutual exclusion), liveness (deadlock freedom), fault tolerance. Consensus algorithms, lock TTL/renewal.
- **Google Maps:** Real-time navigation, location search, route optimization, live traffic, multi-region deployment.
- **Collaborative Document Editor (Google Docs):** Real-time editing, OT or CRDTs, conflict resolution, low-latency sync.
- **Distributed Search Engine:** Crawling, indexing, ranking, query processing at scale, result caching.
- **Global Key-Value Store:** Replication strategies, consistency models, conflict resolution, data partitioning.
- **Real-Time Analytics Pipeline:** Stream processing (Kafka Streams, Flink), data lake, approximate algorithms (HyperLogLog).

## Anti-Patterns (do NOT expect at this level)
- **Waiting for guidance** — passivity is failure signal
- **Name-dropping without justification** — "use Kafka" without explaining why
- **Memorized architectures** applied without adaptation
- **Ignoring failure modes** — should anticipate "What if X fails?"
- **Inflexibility when constraints change**
- **Forgetting user experience** — e.g., not considering <300ms search latency on mobile
- Well-constrained, narrow problems — ambiguity IS the test

## Probe Patterns
- "Chose eventual consistency — walk through a scenario where that causes user-visible problem" (consistency depth)
- "Region A offline. Walk through in-flight requests and recovery." (disaster recovery)
- "Single leader for writes. What at 10x when leader bottlenecks?" (scalability limits)
- "PM says add real-time collaborative editing. How does design change?" (adaptability)
- "What are operational implications? What does on-call engineer monitor?" (production-readiness)
- "This costs $X/month. CFO wants 40% cut. What do you sacrifice?" (cost-aware engineering)
- "How to migrate from current architecture to this with zero downtime?" (migration planning)
- "Unlimited engineers vs. team of 3 — what differently?" (prioritization and pragmatism)

## Sources
- Interviewing.io — Senior Engineer's Guide to System Design
- System Design Handbook — Questions for Senior Engineers
- Medium — 10 Realistic System Design Questions for Senior Engineers
- GeeksforGeeks — System Design Guide for Senior Engineers
- AlgoMaster — Design a Locking Service
- Level Up Coding — System Design Expectations Junior to Principal
