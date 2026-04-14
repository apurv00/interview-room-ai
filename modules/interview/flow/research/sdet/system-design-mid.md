# SDET / QA Engineer — System Design Interview — Mid Level (3-6 years)

NOTE: THE primary system design round for SDETs. About test automation frameworks and infrastructure.

## Topic Sequence (typical order)
1. **Test automation framework design** — architecture, layers, patterns, extensibility
2. **CI/CD pipeline testing strategy** — what runs when, parallel execution, quality gates
3. **Test data management at scale** — factories, isolation, cleanup, environment management
4. **Flaky test management system** — detection, quarantine, retry, reporting
5. **Cross-service integration testing** — contract testing, E2E across microservices
6. **Performance testing infrastructure** — load generation, metrics collection, baseline comparison
7. **Test reporting and analytics** — dashboards, trends, failure classification
8. **Framework maintainability** — plugin architecture, custom matchers, reporter interfaces

## Phase Structure
- **Problem statement (5 min):** "Design a test automation framework for X" or "Design a test service"
- **Architecture (10-15 min):** Layers (driver, page objects, test logic, data, reporting), patterns, extensibility
- **Deep-dive (15-20 min):** Interviewer picks: parallel execution, flaky management, data isolation, CI integration
- **Scaling discussion (5-10 min):** "What changes from 100 to 10,000 tests?"
- **Tradeoffs (5 min):** Custom vs. off-the-shelf, speed vs. coverage, maintenance cost

## What Makes This Level Unique
- Amazon, Google, Microsoft all ask "design a test automation framework" at this level
- Must demonstrate building **custom frameworks, not just using off-the-shelf tools**
- Key differentiators: **parallel execution reasoning, test data isolation, flaky management, framework maintainability**
- Must know when to customize vs. use existing tools
- SDET-specific: the "system" you're designing IS the test system

## Common Problems
- "Design E2E test framework for a microservices e-commerce platform"
- "Design performance testing infrastructure for 100K concurrent users"
- "Design test reporting/analytics platform showing trends and failure patterns"
- "Design API contract testing system for 15 microservices"
- "Design test data management system supporting parallel test execution"
- "Design visual regression testing system for a design-system-heavy app"

## Anti-Patterns
- Over-architecting (10 layers of abstraction for 50 tests)
- Ignoring flaky tests in the design
- No test data isolation strategy (tests depend on shared state)
- Designing only for happy path (no failure handling in the framework itself)
- Cannot explain how framework integrates with CI/CD
- No consideration of developer experience (test authoring should be easy)

## Probe Patterns
- "How handle a test that passes locally but fails in CI?"
- "100 tests → 10,000 tests — what breaks in your design?"
- "How do parallel tests avoid stepping on each other's data?"
- "New team member writes their first test — how easy is it?"
- "How detect whether a failure is a product bug or test infrastructure bug?"

## Sources
- LinkedIn (Adeel Mansoor) — System Design for SDET
- Amazon SDET interviews (GeeksforGeeks, Preplaced)
- TheLinuxCode — SDET Interviews 2026
- Glassdoor — Amazon/Google/Microsoft SDET Reports
