# Backend Engineer — System Design Interview — Mid Level (3-6 years)

## Topic Sequence (typical order)
1. **Requirements gathering** (functional AND non-functional: scale, latency, availability)
2. **Back-of-envelope estimation** (QPS, storage, bandwidth)
3. **High-level architecture** (API gateway, services, database, cache, CDN, queues)
4. **API design with versioning and pagination**
5. **Data model design with indexing strategy and read/write pattern analysis**
6. **Caching strategy** (layers, invalidation, TTL, cache-aside vs. write-through)
7. **Scalability deep-dive** (horizontal scaling, sharding, replication)
8. **Message queues and async processing**
9. **Trade-off discussion** (consistency vs. availability, latency vs. throughput)
10. **Monitoring, alerting, and failure handling**

## Phase Structure
Interview is **collaborative** — interviewer guides but candidate contributes direction:
- **Requirements Gathering (5-8 min):** Candidate proactively asks about scale, read/write ratio, latency, geographic distribution.
- **High-Level Design (10-15 min):** Complete architecture with multiple components. Should be done relatively quickly — spending too long here is a red flag.
- **Component Deep-Dive (15-20 min):** Interviewer picks 1-2 components for depth. Staying at the high level is the #1 mid-level failure mode.
- **Scaling & Trade-offs (5-10 min):** Interviewer changes constraints ("What if 100x traffic?", "What if 3 continents?").
- **Failure Modes (5 min):** "What happens when X fails?" — resilience thinking.

## What Makes This Level Unique
- Same problems may be given as senior level, but with **more interviewer guidance and narrower scope**.
- Must go **deeper than the high-level diagram** — surface-level designs are a red flag.
- Expected to reason about **scalability and performance** but not global-scale multi-region systems.
- Should know **specific technologies** with justification (Redis for caching, Kafka for events, PostgreSQL vs. DynamoDB) — not name-dropping.
- Must demonstrate **independence** in design but can receive nudges.
- When introducing load balancer or API gateway, interviewers **won't probe basic functionality** unless they detect misunderstanding.

## Common Problems/Scenarios Given
- **URL Shortener (deeper):** Caching popular links, database sharding, analytics tracking, TTL/expiration.
- **Chat/Messaging System (WhatsApp):** Message storage, delivery guarantees, read receipts, WebSocket at scale, message ordering.
- **Rate Limiter:** Token bucket vs. sliding window, distributed rate limiting with Redis, race conditions.
- **News Feed System:** Fan-out on write vs. read, ranking algorithms, notification triggers, caching hot feeds.
- **Notification System:** Multi-channel (email, SMS, push), priority queues, retry logic, delivery tracking.
- **Web Crawler:** URL frontier, deduplication (URL and content level), politeness, distributed crawling.
- **Social Media Feed (Twitter):** Tweet storage, timeline generation, follower graph, trending topics.

## Anti-Patterns (do NOT expect at this level)
- Multi-region global architectures with cross-region consistency
- Deep consensus algorithm knowledge (Paxos, Raft)
- Novel data structures or algorithm invention
- Fully leading the interview without guidance
- Organizational/cross-team impact discussion
- Name-dropping without explaining "why it fits" (negative signal)
- Staying at high-level diagram without depth (#1 failure mode)

## Probe Patterns
- "You said Kafka — why not SQS?" (depth beyond name-dropping)
- "What's your sharding strategy? What's the shard key?" (data modeling depth)
- "Cache goes down — does the system still work?" (resilience)
- "How do you handle thundering herd on cache expiry?" (real-world experience)
- "Is eventual consistency acceptable here? What if user reads stale data?" (CAP awareness)
- "Single point of failure here — how to fix?" (receive and act on feedback)
- "Requirements changed: need US and EU. What changes?" (adaptability)

## Sources
- IGotAnOffer — System Design Interview Questions & Prep
- Exponent — System Design Interview Guide
- System Design Handbook — Acing the FAANG System Design Interview
- freeCodeCamp — Systems Design for Interviews
- ByteByteGo — Design a News Feed System
- Hello Interview — Design a Web Crawler
