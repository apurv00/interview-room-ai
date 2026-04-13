# SDET / QA Engineer — Technical Interview — Mid Level (3-6 years)

## Topic Sequence (typical order)
1. **Test framework architecture** — POM, Screenplay Pattern, data-driven/keyword-driven/hybrid, when each
2. **CI/CD testing integration** — smoke on commit, regression on merge, quality gates, parallel execution
3. **API testing depth** — contract testing (Pact), REST-Assured, schema validation, auth testing
4. **Performance testing** — JMeter/Gatling/k6, bottleneck analysis, response time/throughput, APM
5. **Test data management** — factories over fixtures, external sources, isolation, cleanup
6. **Flaky test management** — root cause analysis, quarantine, retry policies, flake rate monitoring
7. **Design patterns in test code** — Singleton (WebDriver), Factory (data), Builder (page objects), Strategy (multi-browser)
8. **Cross-platform testing** — shared logic across web/mobile, device farms (BrowserStack, Sauce Labs)
9. **Shift-left testing** — unit test coaching for devs, PR-level requirements, TDD advocacy
10. **Quality metrics** — meaningful coverage, defect escape rate, automation ROI, execution time trends

## Phase Structure
- **Framework design (8-12 min):** Design test framework for a scenario
- **CI/CD integration (8-10 min):** Pipeline testing, quality gates, parallelization
- **Deep-dive (8-10 min):** Performance, API, or flaky tests based on candidate
- **Tradeoffs (5-8 min):** Coverage vs. speed, when to skip, maintenance costs

## What Makes This Level Unique
- Shifts from "can you use tools" to **"can you design test systems"**
- FAANG heavily weights framework architecture at this level
- Must explain why POM (and when it breaks down), how CI/CD testing works end-to-end
- Key FAANG dimension: "broad understanding of concepts and ability to adapt, rather than specific language proficiency"
- Must know when NOT to automate — not just what to automate
- Google: 16% of tests are flaky; must have a strategy for this

## Anti-Patterns
- Knows tools but cannot explain framework architecture
- No test data or environment strategy
- Treats CI/CD as "someone else's job"
- Only happy-path testing in automation
- Cannot explain when NOT to automate

## Probe Patterns
- "POM breaks down with complex dynamic components — what then?"
- "Smoke suite vs. full regression — how decide?"
- "Walk through a flaky test you diagnosed end-to-end"
- "Suite takes 45 min, team wants 10 — your approach?"
- "What metrics tell you automation investment is paying off?"

## Sources
- Beknazar (Medium) — Top Framework Interview Questions for SDET
- DEV Community — SDET Technical Interview Preparation
- AI Testing Guide — SDET Interview Questions
- TheLinuxCode — SDET Interview 2026
