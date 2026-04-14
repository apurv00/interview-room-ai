# Product Manager — Technical Interview — Mid Level (3-6 years)

NOTE: PM "technical" tests data-driven decision making, experiment design, and engineering tradeoff evaluation — NOT coding.

## Topic Sequence (typical order)
1. **Metrics Framework Design** — "You own Instagram Reels. Design the metrics framework." North star → input metrics → health/guardrail metrics. Connect to business model.
2. **Experiment Design (Rigorous)** — "Design A/B test for changing checkout flow." Statistical significance, MDE, randomization unit, duration, interaction effects, novelty.
3. **Interpreting Ambiguous Data** — "Experiment shows +2% conversion but -5% revenue per user. Ship?" THE signature mid-level question. Tradeoffs, lurking variables, conviction.
4. **Funnel Decomposition at Scale** — "MAU dropped 3% QoQ. Diagnose." Segmentation (new vs. returning, geo, platform, cohort), mix-shift analysis.
5. **Engineering Tradeoff Conversations** — "Engineer says proposed approach adds 200ms latency. Acceptable?" Latency budgets, user-perceived performance, data-driven architecture tradeoffs.
6. **SQL and Analytical Problem-Solving** — At FAANG, actual SQL or pseudo-SQL. "Query: % users who posted a Story within 7 days of first post." Working proficiency.
7. **Technical Architecture Awareness** — "Offline-capable version of this feature — how to think about it?" Client-side storage, sync, caching, product implications.
8. **Instrumentation and Logging Strategy** — "Launching new feature. What events do you log?" Event taxonomy, properties, privacy considerations. Proactive, not retroactive.
9. **Growth/Engagement Modeling** — "Does this drive long-term retention or short-term engagement?" Cohort analysis, retention curves, activation vs. habit formation.

## Phase Structure
- **Phase 1 (0-5 min):** Context-setting, interviewer describes product scenario
- **Phase 2 (5-25 min):** Core metrics/experimentation problem — 20 min collaborative problem-solving (the meat)
- **Phase 3 (25-35 min):** Data interpretation or SQL-style analytical question
- **Phase 4 (35-45 min):** Engineering tradeoff or instrumentation question

## What Makes This Level Unique
- Shift from "do you know what A/B test is" to **"have you actually run one and dealt with messy results."**
- Meta E5 "Analytical/Execution" round is almost entirely: metrics frameworks + experiment interpretation + SQL.
- Expected to **push back on interviewer's framing**. Catching flawed assumptions is strong signal.
- Must **translate between business and engineering language** — not just understand both, but bridge them.
- The **"ambiguous data" question** (ship or don't ship with conflicting metrics) is the canonical mid-level PM technical question across all major tech companies.

## Anti-Patterns
- A/B test without mentioning sample size, duration, or inconclusive handling
- "We need more data" without first reasoning about what available data tells you
- All metrics equally important — no hierarchy, no prioritization
- Looking at aggregates only (not segmenting when diagnosing metric change)
- Over-deferring to engineering ("whatever engineers think") instead of having technical POV
- Ignoring guardrail metrics when recommending launch

## Probe Patterns
- "Experiment ran 2 weeks. Long enough? Why?" (duration, novelty, weekly cycles)
- "North star improved but CEO unhappy. What metric is she looking at?" (stakeholder alignment)
- "Option A: 2 weeks. Option B: 8 weeks but 'better.' What do you do?" (iteration speed vs. completeness)
- "iOS +5%, Android -3%. What now?" (Simpson's paradox, mix effects)
- "P-value is 0.06. Ship or not?" (statistical vs. practical significance)

## Sources
- Meta E5 PM interview rubric (Blind, candidate reports)
- Google L5 PM "Analytical" round — Decode and Conquer 4th ed, Exponent
- Stripe PM interview — heavy metrics and SQL (Glassdoor 2023-2025)
- Trustworthy Online Controlled Experiments (Kohavi, Tang, Xu)
- Lenny Rachitsky — interviews with PM hiring managers
