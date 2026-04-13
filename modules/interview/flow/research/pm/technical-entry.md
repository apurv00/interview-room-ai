# Product Manager — Technical Interview — Entry Level (0-2 years / APM)

NOTE: PM "technical" is NOT coding. It tests analytical fluency, comfort with data, and ability to communicate with engineers.

## Topic Sequence (typical order)
1. **Metrics Definition** — "You launched feature X. What metrics would you track?" Distinguish vanity from actionable. North star + counter-metrics.
2. **Basic Estimation / Fermi Problems** — "How many queries does Google Maps handle daily?" Structured decomposition, stated assumptions, sanity-check.
3. **Funnel Analysis** — "Sign-up conversion dropped 15% WoW. Diagnose." Break user journey into stages, isolate drop-off.
4. **SQL / Data Querying (Conceptual)** — "If you had a table of user events, how would you find users who onboarded but never returned?" Think in data structures.
5. **A/B Testing Fundamentals** — "Test whether new onboarding improves retention." Hypothesis, control/treatment, sample size awareness, success + guardrail metrics. NOT statistical depth.
6. **API / System Basics** — "What happens when you type a URL?" / "Explain an API to a non-technical stakeholder." Baseline technical literacy.
7. **Root Cause Analysis** — "App load time increased 2s. What could cause this?" Hypotheses across client, network, server.
8. **Tradeoff Discussion (Simple)** — "Build native or use third-party integration?" Pros/cons, not deep architecture.

## Phase Structure
- **Phase 1 (0-10 min):** Warm-up metric definition or estimation question
- **Phase 2 (10-30 min):** Core analytical problem (funnel diagnosis or A/B test design)
- **Phase 3 (30-40 min):** Technical literacy probe (API concepts, system basics)
- **Phase 4 (40-45 min):** Quick tradeoff or "how would you work with engineering?"

## What Makes This Level Unique
- Calibrated for **potential, not expertise**. Structured thinking and intellectual curiosity.
- **Estimation questions appear far more frequently** at APM than any other PM level.
- Forgiven for not knowing statistical significance calculations. NOT forgiven for not knowing what A/B testing is.
- Google APM, Meta RPM weight this round heavily — strongest signal for "can this person grow into a technical PM."

## Anti-Patterns
- Naming metrics without explaining WHY they matter or how they connect to business
- Single estimation number without decomposition
- "I'd ask the data team" instead of proposing investigation approach
- Treating A/B testing as magic — not mentioning novelty effect, sample size, selection bias
- Over-jargoning or inability to explain technical concepts simply

## Probe Patterns
- "That metric went up but users are churning. What happened?" (counter-metric awareness)
- "Your estimation seems high — what assumption would you revisit?" (calibration)
- "Engineering says 3 months. Previous PM scoped 2 weeks. What do you do?" (technical communication)
- "No data warehouse access yet. How do you get signal?" (scrappiness)

## Sources
- Lewis Lin — Decode and Conquer (APM prep canon)
- Exponent PM interview database — APM analytical round
- Cracking the PM Interview (McDowell & Bavaro) — Estimation Questions
- Glassdoor: 200+ APM reports from Google, Meta, Uber, Stripe
