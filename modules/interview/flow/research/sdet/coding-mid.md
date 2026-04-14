# SDET / QA Engineer — Coding Interview — Mid Level (3-6 years)

## Problem Types
- **Medium DSA (45%):** LeetCode Medium — trees, graphs (BFS/DFS), basic DP, sliding window, stack/queue. Bar roughly equivalent to SWE but with one fewer hard problem.
- **Test framework code (30%):** Design and implement mini test runner, data-driven test harness, test fixture system. THE signature mid-level SDET challenge.
- **API test automation (15%):** Complete API test suites — parameterized tests, auth handling, schema validation, error scenarios.
- **Page Object / Abstraction layers (10%):** Design page objects or service objects for testing (design patterns, not running Selenium live).

## Difficulty Level
- DSA: LeetCode Medium (BFS shortest path, LRU cache, merge intervals, group anagrams)
- Test-specific: Moderate — designing reusable, maintainable test code, not one-off scripts

## Phase Structure (often 2 coding rounds)
1. **DSA round (45 min):** One medium problem, sometimes with optimization follow-up
2. **Test automation design + code (45 min):** "Design and implement a test framework for X" or "Write API test suite for this spec"
3. **System/integration test scenario (30 min, sometimes combined):** Given distributed system diagram, write integration tests

## What Makes This Level Unique
- Shift from "can you write tests" to **"can you design testable, reusable test infrastructure"**
- Interviewers look for **DRY test code, proper abstractions, maintainability**
- **Fixture and factory patterns**: test data factories, state management, setup/teardown at suite vs. test level
- **CI/CD awareness in code**: deterministic, no flakiness, proper timeouts, retry logic
- **Mocking and stubbing**: when and how — and critically, **when NOT to mock** (over-mocking is red flag)
- **Concurrency testing**: basic thread safety verification

## Common SDET-Specific Problems
- "Design mini test framework: @Test, @BeforeEach, @DataProvider with test runner collecting results"
- "Data-driven API test suite for e-commerce checkout — happy path, validation errors, edge cases"
- "Retry mechanism for flaky integration tests with exponential backoff and max attempts"
- "Page Object Model for multi-step form wizard — abstractions, not Selenium calls"
- "Given Order + Inventory microservices, write integration tests verifying saga pattern"
- "Custom assertion library with fluent API: expect(response).toHaveStatus(200).toMatchSchema(schema)"

## Anti-Patterns
- Test code harder to read than production code
- Over-mocking everything instead of lightweight real dependencies
- No separation between test data setup and test logic
- Tests pass individually, fail together (shared mutable state)
- Ignoring test performance (minutes when should be seconds)
- Copy-pasting tests instead of parameterizing/data-driving

## Sources
- FAANG SDET/SET loops (Google SET L4, Amazon SDE-T II, Meta Production Engineer)
- Test automation conference talks (SeleniumConf, AppiumConf)
- Glassdoor — mid-level SDET at Uber, Stripe, Airbnb, LinkedIn
- Ministry of Testing community discussions
