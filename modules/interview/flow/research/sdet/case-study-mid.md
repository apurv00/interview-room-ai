# SDET / QA Engineer — Case Study Interview — Mid Level (3-6 years)

## Topic Sequence (typical order)
1. **Flaky test strategy for microservices** — diagnose and fix systemic flakiness
2. **Test strategy for database migration** — zero-downtime migration testing plan
3. **CI/CD quality gate redesign** — moving from weekly to continuous deployment
4. **Automation framework selection** — evaluate tools, make data-backed recommendation
5. **Cross-service integration testing** — design testing for multi-service workflows
6. **Regression test optimization** — suite is too slow, reduce without losing coverage
7. **Test data strategy** — managing test data across environments at scale

## Phase Structure
- **Scenario presentation (5 min):** Complex, multi-faceted quality challenge
- **Clarification & constraints (5-10 min):** Ask about team size, deployment frequency, existing infra
- **Strategy design (15-20 min):** Structured approach covering test pyramid, automation, data, environments
- **Complication handling (5-10 min):** Interviewer adds constraints (deadline cut, resource loss)
- **Tradeoff discussion (5 min):** What would you sacrifice? How measure success?

## What Makes This Level Unique
- Must handle **complicating constraints** without restarting — adaptability is key
- The **test pyramid applied to specific system architecture** is the key differentiator
- Expected to discuss **automation ROI with data** — not just "automate everything"
- Must articulate **when to NOT automate** and justify manual testing for specific scenarios
- Cross-service testing strategy demonstrates system-level thinking

## Common Problems
- "Your microservice test suite has 30% flakiness. Design a fix strategy."
- "Team is moving from bi-weekly to daily deploys. Redesign the quality gates."
- "Evaluate: should we build a custom test framework or adopt Playwright?"
- "Database migration from MySQL to PostgreSQL. Design the testing strategy."
- "Regression suite takes 4 hours. Reduce to 30 minutes without losing coverage."
- "Integration tests between Order and Payment services keep failing. Diagnose and fix."

## Anti-Patterns
- Tool-name-dropping without justifying choices
- No test data or environment strategy
- Ignoring flakiness as "just retry"
- No metrics to measure improvement
- Cannot adapt when interviewer changes constraints
- Treats all tests as equally important (no risk-based prioritization)

## Probe Patterns
- "Budget cut in half — what changes?"
- "How measure whether flakiness strategy is working?"
- "Regression suite vs. smoke suite — how decide what goes where?"
- "What's the cost of a false positive vs. false negative in your CI pipeline?"
- "Team resists your framework change — how do you get buy-in?"

## Sources
- Slack Engineering — Handling Flaky Tests at Scale
- Martin Fowler — Practical Test Pyramid
- Glassdoor — Amazon/Google SDET Mid-Level Reports
- Multiple SDET interview guides from Medium/DEV Community
