# Data Science — Case Study Interview — Mid Level (3-6 years)

## Topic Sequence (typical order)
1. **Product metrics investigation** (metric drop / root cause analysis)
2. **Experiment design** (A/B testing for a new feature)
3. **ML modeling case** (recommendation / churn / fraud with business constraints)
4. **Business strategy with data** (should we launch? how measure success?)

## Phase Structure (45-60 min live case)
- **Clarify (5 min):** Define vague terms, metric definitions, user segments, time frames, available data. Don't extend Q&A — use process of elimination.
- **Structure (5 min):** Framework. Metric investigation: decompose (DAU = new + returning + resurrected - churned), segment by platform/geo/user. Experimentation: hypothesis, success metric, sample size, randomization.
- **Analyze (20 min):** Systematically eliminate hypotheses. For modeling: feature engineering, model selection with justification, evaluation metrics.
- **Recommend (10 min):** Crisp recommendation tied to business impact. Include guardrails. Discuss trade-offs.
- **Defend (5 min):** Interviewer pushes back. Stress-tests reasoning. Be flexible, not defensive.

## What Makes This Level Unique
- **Live interactive case**, not take-home. Interviewer provides data points when asked.
- Must think like a **PM + Data Scientist hybrid**: product sense, metrics thinking, statistical rigor combined.
- Must handle **ambiguity gracefully** — interviewers deliberately leave problem vague.
- ~70% of the time the root cause is concentrated in one segment, not spread evenly.
- **40% of rejections** cite lack of business sense (per hiring manager surveys).

## Common Problems
- "DAU dropped 10% last week. Investigate." (Meta)
- "Design A/B test for new recommendation feature." (Airbnb/Netflix)
- "YouTube Shorts engagement declining. Metrics and diagnosis?" (Google)
- "Competitor released feature X. Quantify impact, decide if we build similar?"
- "Design churn prediction system. What would company *do* with predictions?"
- "A/B test: engagement up, revenue down. Launch?" (Meta)

## Anti-Patterns
- Jumping to solutions without clarifying scope
- Over-indexing on model complexity when simple heuristic/logistic regression suffices
- Ignoring business "so what" — model without explaining actions company should take
- Defensive when interviewer pushes back (pushback IS the test)
- A/B test without sample size, duration, confounders
- Confusing correlation with causation in root cause analysis

## Probe Patterns
- "What if metric change is not statistically significant?"
- "Segmented by geography — uniform across regions. Now what?"
- "Guardrail metrics alongside primary?"
- "How handle selection bias in this experiment?"
- "Stakeholder wants to launch on 1-week test. Recommendation?"
- "Cost of false positive vs. false negative for this model?"

## Sources
- Hacking the Case Interview — DS Case Interview Guide 2026
- StrataScratch — Types of Product Sense Questions
- DataLemur — Meta DS Interview Guide
- DataInterview — Product Sense Interview Questions (FAANGs)
