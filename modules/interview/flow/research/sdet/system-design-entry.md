# SDET / QA Engineer — System Design Interview — Entry Level (0-2 years)

NOTE: SDET system design is about test infrastructure, NOT backend services.

## Topic Sequence (typical order)
1. **Test organization for a simple app** — how structure tests (unit, integration, E2E)
2. **Basic test pyramid application** — explain and apply to a given system
3. **Simple automation setup** — how set up automated tests for a web app
4. **Test environment basics** — what environments needed, how data managed
5. **CI integration awareness** — where do tests run, how triggered

## Phase Structure
- **RARE as standalone round** at entry level. Appears as lightweight question within broader technical interviews.
- Typically: "How would you set up testing for this app?" (15-20 min within another round)
- Scoped to single service/application, not distributed systems

## What Makes This Level Unique
- Demonstrate **test organization thinking**, not infrastructure architecture
- Basic understanding of **test pyramid** and why it matters
- Awareness that automation requires maintenance
- Interviewers accept simple, practical answers — no complex framework design expected
- Must show understanding of WHERE tests run (local, CI, staging) even if not how to set it up

## Common Problems
- "How would you set up testing for a to-do list web app?"
- "Where would you put unit, integration, and E2E tests for this service?"
- "How would you organize test files in this project?"
- "What test environments would you need for this app?"

## Anti-Patterns
- Naming tools without explaining the architecture around them
- No mention of the test pyramid
- Cannot distinguish where different test types run
- Over-engineering with Kubernetes, docker-compose for a simple app
- No awareness that tests need maintenance

## Probe Patterns
- "Why more unit tests than E2E?"
- "Where do these tests run — your machine or CI?"
- "Test fails only in CI, passes locally — why?"
- "How do you keep test data clean between runs?"

## Sources
- GeeksforGeeks — SDET Interview Questions
- Amazon SDET interview experiences (GeeksforGeeks, Preplaced)
- InterviewBit — SDET Interview Questions
