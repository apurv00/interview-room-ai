# SDET / QA Engineer — Technical Interview — Entry Level (0-2 years)

## Topic Sequence (typical order)
1. **Testing fundamentals** — types (unit, integration, E2E, smoke, regression), when to use each
2. **Test pyramid** — shape, cost tradeoffs, why more unit and fewer E2E
3. **Test case design** — boundary value analysis, equivalence partitioning, error guessing, decision tables
4. **Bug lifecycle** — New → Assigned → Open → Fixed → Retest → Verified/Reopen → Closed
5. **Basic automation** — Selenium/Cypress/Playwright tests, element location, assertions, waits
6. **Manual vs. automation decisions** — when to automate, ROI, what stays manual
7. **Version control for tests** — test code in repos, branching, test code in CI
8. **Basic API testing** — HTTP methods, status codes, testing REST endpoints

## Phase Structure
- **Fundamentals check (5-8 min):** Testing concepts, pyramid, test types
- **Practical application (12-15 min):** Write or walk through a test
- **Tool awareness (5-8 min):** Tools chosen and why, basic CI/CD understanding

## What Makes This Level Unique
- Assesses **solid foundation in testing principles** beyond tool proficiency
- Differentiator: understanding *why* test levels exist, thinking about edge cases systematically
- Industry consensus: "Selenium + TestNG + Maven + POM" covers ~70% of fresher interviews
- Best candidates articulate **testing thinking** — not just tool mechanics
- SDET vs. Manual QA: must show coding comfort and automation interest

## Anti-Patterns
- Cannot explain the testing pyramid
- Only knows one tool with no underlying principles
- Confuses SDET with manual QA role
- Cannot write a basic test case for a login form
- Does not know verification vs. validation
- Cannot describe a good bug report structure

## Probe Patterns
- "Boundary value analysis applied to this login form?"
- "Why Selenium over Cypress — tradeoffs?"
- "Test fails in CI — how debug?"
- "How test this feature with zero automation tools?"

## Sources
- GeeksforGeeks — SDET Interview Questions and Answers
- InterviewBit — SDET Interview Questions
- Guru99 — SDET Interview Questions
- MasterSoftwareTesting — Test Case Design Techniques
