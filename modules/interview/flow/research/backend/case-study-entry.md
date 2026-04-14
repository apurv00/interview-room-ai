# Backend Engineer — Case Study Interview — Entry Level (0-2 years)

## Topic Sequence (typical order)
1. **Problem statement comprehension and clarifying questions**
2. **Basic API endpoint design** (REST verbs, routes, request/response)
3. **Simple database schema design** (tables, relationships, basic normalization)
4. **Implementation walkthrough of one specific feature**
5. **Basic error handling and edge cases**
6. **Testing approach** ("What tests would you write?")
7. **Simple performance considerations** (caching basics, indexing)
8. **Summary and validation against original requirements**

## Phase Structure
Interview is **interviewer-led**:
- **Setup (5 min):** Interviewer presents a scenario based on a real past project. Problem is phrased as a non-technical stakeholder would describe it.
- **Clarification (5-10 min):** Candidate asks questions. Interviewers deliberately omit details to test whether candidate identifies missing info.
- **Propose (5 min):** Candidate gives short overview — technologies, structure, data model.
- **Implement/Walk Through (20-25 min):** Walk through (or code) one specific feature. Some companies let candidates share screen and implement in any language.
- **Validate (5 min):** Confirm design meets original requirements.

## What Makes This Level Unique
- Interviewers **drive the interview** and provide guidance/hints throughout.
- Focus on **foundational reasoning**, not production-ready designs.
- Testing ability to **translate non-technical problem statements** into working solutions.
- Scenarios are **small and well-scoped** — single feature, simple data model.
- Emphasis on **communication and thought process** over deep technical knowledge.
- No expectation of distributed systems, microservices, or complex scaling.

## Common Problems/Scenarios Given
- Design a REST API for a to-do list app (CRUD operations, basic auth)
- Simple CRUD application (bookstore inventory with add/edit/delete/search)
- Debug a broken endpoint (given non-working API, identify and fix the bug)
- Design a simple database schema (blog with users, posts, comments)
- Basic caching scenario ("Your API is slow. How would you speed it up?")

## Anti-Patterns (do NOT expect at this level)
- Microservices architecture, event-driven systems, message queues
- Distributed tracing, observability stacks, monitoring tools
- Production incident debugging or on-call scenarios
- Kubernetes, Terraform, NGINX configuration
- Database sharding, replication, CAP theorem
- Candidate leading the interview unprompted

## Probe Patterns
- "What if we needed to add a new field?" (schema evolution)
- "What if two users update the same record?" (basic concurrency)
- "How would you test this endpoint?" (testing awareness)
- "What HTTP status code here?" (REST fundamentals)
- "Why did you choose that?" (reasoning, not recall)

## Sources
- DEV Community — The Software Engineer Case Study Interview
- Revelry — Here's Why We Do Case Interviews For Software Engineers
- Medium — Interview Edition: Design a REST API as a Junior Engineer
- Aspect HQ — Junior Backend Engineer Interview Questions
- GeeksforGeeks — Backend Developer Interview Questions
