# Data Science — System Design Interview — Entry Level (0-2 years)

NOTE: DS system design is about ML pipelines, NOT backend infrastructure.

## Topic Sequence (typical order)
1. **Basic ML pipeline concepts** — data ingestion, feature engineering, training, serving
2. **Simple end-to-end model deployment discussion**
3. **Evaluation metrics and offline vs. online testing basics**

## Phase Structure
- **Rarely asked** at entry level for DS roles. When it appears, simplified 30-min version.
- Typically embedded within technical screen, not standalone.
- Format: "Walk me through building [simple ML system] from data to production."

## What Makes This Level Unique
- Entry-level ML roles are rare unless MS/PhD
- When asked, expectations low: demonstrate awareness ML is more than `model.fit()`
- Must understand **concept** of pipeline (data in → features → model → predictions → monitoring)
- No infrastructure depth expected (no Kafka, Kubernetes, feature stores)
- Focus: what data needed, how to label, what model to try first, how to know if it's working

## Common Problems
- "Build a spam classifier for emails. Walk through pipeline." (simplified)
- "User click data — how build a simple recommendation system?"
- "Take Jupyter notebook model to production — describe how."
- "Build sentiment analysis for product reviews."

## Anti-Patterns
- Complex architectures (microservices, Kubernetes, streaming) for simple problem
- Not mentioning data collection and labeling as first/hardest step
- Forgetting evaluation — model with no measurement plan
- Treating as backend system design instead of ML pipeline

## Probe Patterns
- "Where does training data come from?"
- "How evaluate if model is good enough to deploy?"
- "What when new data looks different from training data?"
- "How know if model making bad predictions in production?"

## Sources
- IGotAnOffer — ML System Design Interview
- Exponent — ML System Design Interview 2026
- Hello Interview — ML System Design in a Hurry
- GitHub — alirezadir ML System Design
