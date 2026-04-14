# SDET / QA Engineer — System Design Interview — Senior Level (7+ years)

## Topic Sequence (typical order)
1. **Self-service test platform** — internal product serving all engineering teams
2. **Multi-tenant test infrastructure** — different teams, stacks, needs on shared infra
3. **Quality metrics and SLO framework** — org-wide quality measurement and reporting
4. **Contract testing platform for microservices** — provider verification, consumer contracts
5. **Visual regression at scale** — screenshot comparison, diff scoring, baseline management
6. **Intelligent test selection** — change-impact analysis, risk-based prioritization, historical failure analysis
7. **Chaos engineering integration** — fault injection, game days, production resilience testing
8. **Test infrastructure observability** — monitoring the test system itself (not just the product)
9. **Developer experience for test authoring** — SDK design, documentation, onboarding
10. **Cost modeling and efficiency** — infrastructure costs, resource utilization, optimization

## Phase Structure
- **Architecture discussion (15-20 min):** Design test platform for a large org. Candidate drives.
- **Multi-tenancy and scaling (10 min):** 5 teams → 50 teams. Different stacks, different needs.
- **Metrics and adoption (10 min):** How measure platform success? How drive adoption?
- **Advanced topics (10 min):** Chaos engineering, intelligent selection, observability
- **Leadership and strategy (5 min):** How get buy-in? How handle teams that resist?

## What Makes This Level Unique
- Senior SDET system design is about **platform thinking** — self-service infrastructure as an internal product
- Must reason about **multi-tenancy, extensibility, cost models, developer experience**
- Must discuss **phased organizational adoption**, not big-bang rollout
- **Cross-cutting concerns** (security scanning, accessibility testing, compliance) should surface naturally
- Test infrastructure has its OWN observability (monitoring the monitors)
- Must have opinions on emerging tech: AI-assisted testing, self-healing locators, testing in production

## Common Problems
- "Design self-service test infrastructure for an org with 50 engineering teams"
- "Design visual regression testing platform that handles 10,000 screenshots/day"
- "Design contract testing platform for 100+ microservices"
- "Design intelligent test selection that reduces CI time by 70%"
- "Design quality metrics platform — define what to measure, how to collect, how to report"
- "Design chaos engineering framework integrated with test infrastructure"

## Anti-Patterns
- Designing for one team instead of the organization
- Proposing big-bang migration instead of phased adoption
- No developer experience consideration (platform nobody wants to use)
- Ignoring cost (unlimited resources assumption)
- No strategy for backwards compatibility when evolving platform APIs
- Cannot connect test metrics to business outcomes
- Building everything custom when proven open-source exists (unless gaps articulated)

## Probe Patterns
- "How handle teams that don't want to use the shared platform?"
- "Design for 5 to 50 teams — what changes architecturally?"
- "How measure test effectiveness — not just coverage, catching real bugs?"
- "Platform team is 5 people serving 200 engineers. How prioritize requests?"
- "How ensure platform changes don't break existing team tests?"
- "What's your adoption strategy for teams with legacy test suites?"

## Sources
- Netflix/Uber/Stripe engineering blogs on test infrastructure
- LinkedIn (Adeel Mansoor) — System Design for SDET
- "Software Engineering at Google" — Testing at Scale chapters
- Glassdoor — Staff/Principal SDET at Google, Amazon, Apple
