# General / Any Role — System Design Interview — Mid Level (3-6 years)

## Topic Sequence (typical order)
1. **Requirements gathering** and constraint definition
2. **High-level architecture** (HLD) with component breakdown
3. **Low-level design** (LLD) for critical components
4. **Database selection** and schema with trade-offs
5. **Caching strategy** and CDN integration
6. **Scalability patterns** (sharding, replication, partitioning)
7. **Monitoring, logging,** and operational concerns
8. **Trade-off discussion** and design evolution

## Phase Structure
- Candidate-driven with interviewer providing constraints/curveballs
- 45-60 min, both HLD and LLD expected
- Start: requirements → capacity estimation → HLD → deep dive 2-3 components → trade-offs
- Standard: messaging system, notification service, URL shortener at scale, distributed cache, web crawler

## What Makes This Level Unique
- "Can they build end-to-end?" Must reason about scalability AND performance
- Handle curveballs (requirements change mid-discussion)
- Must address operational concerns (monitoring, logging, alerting) — missing this signals lack of real ownership
- Every decision needs explicit trade-off discussion
- Must estimate capacity (QPS, storage, bandwidth)

## Anti-Patterns
- Rushing into design without gathering requirements (#1 mistake)
- Tackling entire system at once instead of breaking into components
- Not discussing trade-offs
- Ignoring operational concerns
- Overcomplicating with advanced patterns when simple suffices

## Sources
- System Design Handbook — Top 40 Questions 2026
- GeeksforGeeks — Common Mistakes in System Design
- DEV Community — 9 Things Engineers Get Wrong
