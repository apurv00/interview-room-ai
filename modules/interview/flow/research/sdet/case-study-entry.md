# SDET / QA Engineer — Case Study Interview — Entry Level (0-2 years)

## Topic Sequence (typical order)
1. **Design test plan for a feature** — given a feature spec, create comprehensive test scenarios
2. **Find bugs in a specification** — identify gaps, ambiguities, and edge cases in requirements
3. **Write test cases for a workflow** — checkout flow, registration, search — structured coverage
4. **Risk-based test prioritization** — limited time, which tests matter most?
5. **Bug investigation walkthrough** — a bug was reported, how do you investigate?
6. **Manual vs. automated test decision** — given constraints, what approach for this feature?

## Phase Structure
- **Scenario presentation (5 min):** Feature spec or bug report provided
- **Clarification (5 min):** Ask about users, platforms, edge cases, acceptance criteria
- **Test plan creation (15-20 min):** Structured test cases covering happy path, edge cases, negative cases
- **Prioritization (5-10 min):** If time is limited, what do you test first and why?
- **Discussion (5 min):** What would you automate? What stays manual?

## What Makes This Level Unique
- Assessed on **structured thinking and basic risk awareness**, not deep strategy
- STAR method and step-by-step test planning are dominant patterns
- Scenarios are **feature-scoped** — single feature, well-defined scope
- Must show ability to think beyond happy path without prompting

## Common Problems
- "Design a test plan for the checkout flow of an e-commerce site"
- "Here's a registration form spec. What test cases would you write?"
- "A user reports the search isn't returning results. How do you investigate?"
- "You have 2 hours to test this feature before release. What do you do?"
- "Write test cases for a login page — consider security, usability, performance"

## Anti-Patterns
- Listing every test type without prioritization
- Only happy-path test cases
- No consideration of edge cases (empty fields, special characters, concurrent users)
- Cannot structure tests into categories (functional, boundary, negative, security)
- No mention of platform/browser considerations

## Probe Patterns
- "What's the most important test case and why?"
- "What if the user has a slow network connection?"
- "How would you test this on mobile vs. desktop?"
- "What would you automate first?"

## Sources
- TestRigor — Scenario-Based QA Interview Questions
- Martin Fowler — Practical Test Pyramid
- Glassdoor — Amazon/Google SDET Entry-Level Reports
