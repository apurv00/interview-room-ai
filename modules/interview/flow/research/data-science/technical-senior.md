# Data Science — Technical Interview — Senior Level (7+ years)

## Topic Sequence (typical order)
1. **ML system design** — End-to-end: data ingestion, feature stores, training pipeline, serving, monitoring, A/B integration
2. **Causal inference methods** — Diff-in-diff, instrumental variables, propensity score matching, regression discontinuity, synthetic controls — when RCTs are infeasible
3. **Advanced experimentation** — Interference/network effects, switchback experiments, multi-armed bandits, Bayesian optimization, sequential testing
4. **Research-to-production pipeline** — Paper/prototype to production: validation, scaling, latency optimization, model compression
5. **Recommendation system design** — Collaborative/content-based/hybrid, cold-start, real-time personalization, two-tower models
6. **Advanced statistics** — Bayesian methods, survival analysis, time series (ARIMA, Prophet, deep), hierarchical models
7. **ML fairness, bias, reliability** — Detecting/mitigating bias, fairness constraints, explainability (SHAP, LIME), responsible AI
8. **Data platform decisions** — Build vs buy, data mesh vs warehouse, real-time vs batch, feature platform architecture
9. **Search ranking & ads** — Learning-to-rank, click models, position bias, ad auction, CTR prediction at scale
10. **Technical leadership** — Code review for ML, experiment review processes, modeling best practices across teams

## Phase Structure (Staff/Principal pattern)
- **Phone Screen (60 min):** Deep technical discussion on past work + 1 coding/SQL
- **Onsite Round 1 — ML System Design (60 min):** Full ML system (recommendation, fraud, search ranking)
- **Onsite Round 2 — Experimentation & Causal Inference (45-60 min):** Complex scenarios, observational methods
- **Onsite Round 3 — Technical Deep Dive (45 min):** Past work, architecture decisions, trade-offs
- **Onsite Round 4-5 — Behavioral/Leadership (45 min each):** Strategic influence, team-building

## What Makes This Level Unique
- **ML system design is the marquee round:** "For senior (E5+), walk through how you'd architect a DS solution end to end"
- **Causal inference is gating:** "Microsoft leans heavily on experimentation and causal inference... candidates who only prepped supervised learning are underprepared"
- Must reason about **ML systems at scale**: "balance accuracy, latency, cost, user experience while clearly explaining reasoning"
- Netflix: "experimentation round focuses on designing and evaluating experiments, diagnosing failed experiments, reasoning about bias, interference, measurement error"
- **Research fluency expected** — discuss recent papers, understand limitations, critique methodologies
- Must "develop fluency in causal reasoning without overreliance on experiments"
- 6-step ML System Design: (1) Define problem, (2) Data pipeline, (3) Model architecture, (4) Training strategy, (5) Serving infra, (6) Evaluation & monitoring

## Anti-Patterns
- **Only supervised learning:** Underprepared at senior level
- **No causal thinking:** Correlation-based solutions to causal questions
- **Ignoring scale:** Systems for 1K users that break at 1M
- **Treating ML system design like SWE system design:** Missing feature stores, training pipelines, model monitoring, retraining, drift
- **No opinion on trade-offs:** Must have POV on build-vs-buy, real-time vs batch, complexity vs interpretability
- **Academic-only causal inference:** Theory without messy real-world application
- **Handwaving on monitoring:** No degradation detection, alerts, retraining triggers

## Probe Patterns
- "Design recommendation system for new product with no user history" (cold-start + system design)
- "Can't A/B test this change. How estimate causal effect?" (causal inference without RCT)
- "Model latency 200ms, SLA 50ms. What do you do?" (production trade-offs)
- "Detect if feature is proxying for protected attribute?" (fairness)
- "Take this paper's approach and deploy to 100M users" (research-to-prod)
- "Team disagrees on evaluation metric. How resolve?" (technical leadership)

## Sources
- Exponent — ML System Design Interview Guide (2026)
- IGotAnOffer — ML System Design Interview
- HelloInterview — ML System Design in a Hurry
- Towards Data Science — Causal Inference Interview Prep
- DataInterview — Microsoft DS Interview Guide
- InterviewQuery — Netflix DS Interview Guide
