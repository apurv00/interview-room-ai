# Backend Engineer — System Design Interview — Entry Level (0-2 years)

## Topic Sequence (typical order)
1. **Requirements gathering** (functional only; non-functional prompted by interviewer)
2. **High-level component identification** (client, server, database)
3. **API design** (REST endpoints, HTTP methods, basic request/response)
4. **Data model design** (tables, basic relationships, primary/foreign keys)
5. **Basic read/write flow walkthrough**
6. **Simple caching introduction** (what is a cache, where would you put one)
7. **Basic load balancing concept** (what it is, why needed — no vendor specifics)
8. **Summary and gap identification**

## Phase Structure
Interview is **interviewer-driven** with heavy guidance:
- **Problem Statement (3-5 min):** Well-defined, narrow problem (e.g., "Design a URL shortener"). Scope intentionally limited.
- **Requirements Discussion (5-10 min):** Interviewer guides through functional requirements. Non-functional may be stated explicitly. Evaluated on whether candidate asks clarifying questions before jumping in.
- **High-Level Design (10-15 min):** Basic architecture: client, API server, database, possibly cache. Interviewer expects to see understanding of how components connect.
- **Detailed Design of One Component (10-15 min):** Interviewer picks one area (usually data model or API) and asks to go deeper. Guided — interviewer may say "Let's talk about your database schema."
- **Simple Scaling Question (5 min):** "What if 10x more users?" — tests awareness that concepts like caching and load balancing exist.

## What Makes This Level Unique
- Many companies **skip system design entirely** for juniors. Amazon doesn't ask system design for new grads, reserving it for 4-5+ years.
- When asked, problems are **basic and well-constrained**.
- Interviewer **expects to drive** — they steer toward important areas.
- Evaluation: **"Can this person learn to design systems?"** — not "Can they design production systems?"
- Focus on **clarity, structured thinking, and fundamentals** — not depth.
- Knowing a load balancer exists and why is sufficient — NOT when to use NGINX vs. AWS ALB.
- A working, correct solution for a simple case beats a complex but incomplete solution for a hard case.

## Common Problems/Scenarios Given
- **URL Shortener (TinyURL):** Unique short keys (base-62), store mappings, handle redirects. Focus on correctness.
- **Simple API design** (to-do list, bookstore, parking lot): REST conventions, HTTP methods, CRUD.
- **Basic chat application:** Client-server model, message storage/retrieval, basics of WebSocket vs. polling.
- **Rate limiter (simplified):** What is rate limiting, where to put it, basic token bucket concept.
- **Pastebin:** Store/retrieve text snippets by key.

## Anti-Patterns (do NOT expect at this level)
- Distributed systems, consensus algorithms, CAP theorem
- Sharding strategies, data replication, multi-region deployment
- Name-dropping specific technologies (Kafka, Redis, Cassandra) — concepts suffice
- QPS calculations, storage estimates, bandwidth requirements
- Leading the interview or identifying discussion areas unprompted
- Trade-off analysis between multiple viable approaches
- Message queues, event-driven architecture, CQRS

## Probe Patterns
- "Why SQL here? Could NoSQL work?" (basic awareness of alternatives)
- "What if your database goes down?" (thought about failure at all?)
- "What if two people claim the same short URL?" (basic concurrency)
- "Where would you add a cache?" (concept knowledge)
- "Does the client poll or does the server push?" (client-server interaction)
- "Draw the request flow from user click to response" (end-to-end understanding)

## Sources
- DEV Community — Guide to Ace System Design: Junior vs Senior Engineers
- DesignGurus — Do new grads need system design?
- Quora — System design for entry-level backend developer?
- AlgoMaster — System Design Expectations By Level
- Hello Interview — System Design: What is Expected at Each Level
- Level Up Coding — System Design Expectations from Junior to Principal
