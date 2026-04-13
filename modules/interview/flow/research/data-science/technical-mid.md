# Data Science — Technical Interview — Mid Level (3-6 years)

## Topic Sequence (typical order)
1. **ML algorithm deep dives** — Random Forest vs XGBoost vs LightGBM: internals, when to use, hyperparameter tuning
2. **Feature engineering** — Creating from raw data, categorical handling, interactions, temporal features, text extraction
3. **Model evaluation beyond accuracy** — Precision/recall trade-offs, ROC-AUC vs PR-AUC (imbalanced data), calibration
4. **Experiment design & A/B testing** — Power analysis, sample size, novelty effects, network effects, multiple testing correction
5. **Product metrics & definition** — North star, guardrail, proxy metrics, AARRR funnel framework
6. **Dimensionality reduction & clustering** — PCA, t-SNE, UMAP for EDA; K-means, DBSCAN, hierarchical with real use cases
7. **Production ML fundamentals** — Model serving, feature stores, drift monitoring, retraining, latency vs accuracy
8. **SQL at scale** — Optimization, CTEs, complex window functions, query performance, data warehouses
9. **Deep learning foundations** — Architectures, embeddings, transfer learning, when DL is overkill vs appropriate
10. **Case study / product sense** — Business problem → define metrics → propose data approach → design experiment → present

## Phase Structure (FAANG pattern)
- **Phone Screen (45-60 min):** 1 SQL + 1 Python at medium-hard
- **Onsite Round 1 — Coding (45 min):** Python data manipulation, algorithmic with data focus
- **Onsite Round 2 — Statistics & Experimentation (45 min):** A/B test design, power analysis, interpreting with confounders
- **Onsite Round 3 — ML Deep Dive (45 min):** Algorithm selection, feature engineering, model evaluation for scenario
- **Onsite Round 4 — Product Sense (45 min):** Define metrics, design experiment, reason about business impact
- **Onsite Round 5 — Behavioral (45 min):** Influence, ownership, cross-functional collaboration

## What Makes This Level Unique
- **Experimental design is huge** at Google — A/B testing methodology, power analysis, handling novelty effects
- **Product sense** becomes a distinct round at FAANG — define success, guardrails, propose experiments
- Must discuss **trade-offs fluently**: "balance accuracy, latency, cost, user experience"
- Must show **production awareness**: not just EDA but production-grade ML engineering
- Feature engineering tested as a **design skill**, not just technique
- "Good metrics: Simple, Clear, Actionable" (product sense framework)

## Anti-Patterns
- **Algorithm name-dropping without depth:** "Use XGBoost" without why, hyperparameters, or how it differs
- **Ignoring class imbalance:** Accuracy on imbalanced datasets — "PR-AUC far better than ROC-AUC"
- **No experimentation rigor:** A/B tests without sample size, runtime, peeking handling
- **Startup-only mindset:** Ad-hoc Jupyter without production systems, pipelines, monitoring
- **Weak product sense:** Metrics without gaming, proxy distortion, or guardrails
- **Over-engineering:** Deep learning when logistic regression suffices

## Probe Patterns
- "A/B test shows 2% lift, p=0.08. What do you do?" (statistical judgment)
- "How detect model performance degrading in production?" (monitoring/drift)
- "Design features for fraud detection that adapts over time" (feature creativity)
- "PM wants engagement, VP wants revenue. How define north star?" (product sense)
- "Explain bias-variance tradeoff using your proposed model" (fundamentals grounding)

## Sources
- DataInterview — 120 ML Interview Questions (FAANGs)
- InterviewQuery — Google DS Interview Guide
- Exponent — DS Interview Prep Guide (2026)
- DataLemur — Product Sense Interview Questions
- InterviewNode — ML Interview Tips for Mid/Senior at FAANG
