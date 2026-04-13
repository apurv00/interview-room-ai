# SDET / QA Engineer — Coding Interview — Senior Level (7+ years)

## Problem Types
- **Medium-Hard DSA (30%):** LeetCode Medium-Hard — graph algorithms, advanced DP, concurrency. Weight shifts: DSA ~30% of evaluation, test architecture ~70%.
- **Test infrastructure/platform code (35%):** Custom test orchestrators, distributed test runners, result aggregation, flakiness detection algorithms. This IS the evaluation.
- **Framework architecture (20%):** Testing framework from scratch — plugin architecture, hook systems (beforeAll/Each/afterAll with async), reporter interfaces, parallel execution.
- **CI/CD pipeline scripting (10%):** Pipeline-as-code (Jenkinsfile, GitHub Actions) with intelligent test selection, parallelization, failure analysis.
- **Performance/load test tooling (5%):** Custom load utilities, metrics collection, threshold-based alerting.

## Difficulty Level
- DSA: LeetCode Medium-Hard (often with testing twist — "implement X, then write property-based test proving correctness")
- Test-specific: High — architecture-level design implemented in working code
- 4-5 round loop typically

## Phase Structure
1. **DSA round (45 min):** Medium-hard; coding quality and edge handling weighted heavily
2. **Test platform coding (60 min):** "Design and implement distributed test scheduler" or "Build test result analytics engine"
3. **System design with test architecture (60 min):** Design system AND its testing strategy, with code for critical components
4. **Code review / debugging (45 min):** Review large PR with subtle test infrastructure bugs — architectural issues, not just line-level
5. **Leadership / past projects (45 min):** Deep dive into frameworks built, "show me the code"

## What Makes This Level Unique
- Evaluated as a **platform engineer** who specializes in testing. Code should be production-grade infrastructure.
- **Test selection algorithms**: changed-file-based mapping, risk-based prioritization, historical failure analysis
- **Distributed testing**: orchestrate across machines, handle partial failures, aggregate results, distinguish infra vs. product failures
- **Flakiness detection**: statistical analysis of pass/fail rates, quarantine logic, automatic retry with classification
- **Property-based testing**: QuickCheck/Hypothesis style — generate random inputs, verify invariants
- **Observability integration**: test code emits structured telemetry (traces, metrics, logs)

## Common SDET-Specific Problems
- "Design and implement test orchestrator: 10K tests across 50 machines, dependency-aware scheduling, result aggregation, auto-rerun failures"
- "Flakiness detector: given test results DB (name, pass/fail, timestamp, duration, machine), classify stable/flaky/broken with confidence"
- "Change-impact test selector: dependency graph + changed files → minimal test set with priority ordering"
- "Plugin architecture: core runner, hook system (async before/after), reporter interface. Implement JUnit XML + Slack reporters"
- "Performance harness: 1000 concurrent users, p50/p95/p99 latency, auto-flag regressions against baseline"
- "Visual regression engine: two screenshots → diff score, changed regions, diff image"
- "Contract testing: provider verification that replays consumer contracts against running service"

## Anti-Patterns
- Complex test infrastructure without considering developer experience of test authors
- Over-engineering with excessive abstraction nobody can debug
- Not designing for observability — fails silently or produces unactionable output
- Ignoring resource management (leaked connections, file handles, containers)
- Bespoke solutions when proven open-source exists (unless specific gaps articulated)
- No backwards compatibility strategy when evolving framework APIs
- Treating test code as second-class (no code review, no tests for test infra, no docs)

## Sources
- Staff/Principal SDET reports (Google SET L6+, Meta, Apple, Amazon Principal SDE-T)
- Netflix/Uber/Stripe engineering blogs on test infrastructure
- "Software Engineering at Google" — Testing at Scale chapters
- LinkedIn/Microsoft Principal SDET processes (Glassdoor, Blind)
