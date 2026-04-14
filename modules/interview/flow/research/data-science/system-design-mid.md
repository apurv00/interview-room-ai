# Data Science — System Design Interview — Mid Level (3-6 years)

NOTE: DS system design = ML pipelines (data → features → model → serving → monitoring), NOT databases and microservices.

## Topic Sequence (typical order)
1. **Problem formulation** — translate business goal into ML objective
2. **Data pipeline design** — collection, labeling, feature engineering, feature stores
3. **Model architecture and training** — selection, trade-offs, offline evaluation
4. **Serving infrastructure** — batch vs. real-time, latency requirements
5. **Online evaluation and deployment** — A/B testing, canary, shadow mode
6. **Monitoring, drift detection, iteration**

## Phase Structure (45-60 min)
- **Clarify requirements (5 min):** Business goal, users, latency/throughput, batch or real-time, available data.
- **Define metrics (5 min):** Offline (AUC, NDCG, precision@k) AND online (CTR, engagement, revenue). Why they can diverge.
- **High-level architecture (10 min):** Pipeline: ingestion → feature store → training → model registry → serving → monitoring. ML vs. non-ML components.
- **Deep dive (20 min):** Interviewer picks 1-2 components. Common: feature engineering, model selection, or serving.
- **Scaling and trade-offs (5 min):** 10x scale? Bottlenecks? What to sacrifice (latency, freshness, coverage)?

## What Makes This Level Unique
- **Standard interview round** at L4-L5 Google, E4-E5 Meta
- Must design multi-component: **candidate generation → ranking → re-ranking** (canonical recommendation/search pattern)
- Feature engineering **in depth**: specific representations, encoding strategies, high-cardinality categoricals
- Two-tower models, multi-task learning, ANN search are **expected vocabulary**
- Must distinguish offline metrics (training optimization) from online metrics (business) and explain disagreement

## Common Problems
- "Design recommendation system for Netflix / YouTube / TikTok For You page"
- "Design search ranking for e-commerce / job search"
- "Design fraud detection pipeline for Stripe / banking"
- "Design notification relevance system"
- "Design content moderation / harmful content detection"
- "Design ad click prediction system"
- "Design 'People You May Know' friend suggestion"

## Anti-Patterns
- Defaulting to transformers/LLMs without justification when gradient-boosted trees suffice
- Designing for unrealistic scale without grounding in constraints
- Over-engineering (real-time features when batch suffices)
- Missing candidate generation → ranking → re-ranking for retrieval
- Not discussing labeling strategy (where do training labels come from?)
- Forgetting monitoring and feedback loops
- Treating as Kaggle competition instead of production system

## Probe Patterns
- "Why this architecture over alternative? Trade-offs?"
- "Cold start for new users / items?"
- "Feature store goes down — how does system degrade?"
- "How detect data drift? What do when detected?"
- "Walk through single prediction request through system."
- "How A/B test? Randomization unit?"
- "Latency budget? Where are bottlenecks?"

## Sources
- Hello Interview — ML System Design in a Hurry
- GitHub — alirezadir ML System Design (9-step framework)
- Exponent — ML System Design Interview 2026
- Chip Huyen — ML Systems Design Exercises
- InterviewNode — ML Tips for Mid/Senior at FAANG
