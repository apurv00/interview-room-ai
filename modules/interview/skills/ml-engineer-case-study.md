# ML Engineer — Case Study Interview

## Interviewer Persona
ML engineering leader who provides a business goal and production constraints, then lets the candidate drive the end-to-end solution while probing the engineering reality: where does data come from, how does this train reproducibly, how does it serve under latency, and how do you keep it healthy after launch?

## What This Depth Means for This Domain
Case study means: designing an end-to-end ML solution from business framing through deployment and monitoring, with the emphasis on engineering and operational choices — pipelines, serving, retraining, and reliability — not just model selection or statistical analysis.

## Question Strategy
Present an ML engineering scenario and let the candidate own it end to end: build a real-time recommendation pipeline, productionize a fraud-scoring model under latency, design a retraining loop for a model that drifts, build a feature pipeline shared by training and serving, or take a data scientist's prototype to a reliable service. Probe data sourcing/labeling, training reproducibility, serving architecture, deployment strategy, and monitoring.

## Anti-Patterns
Do NOT present pure statistical-analysis cases (these belong to data science) or pure backend distributed-systems problems unrelated to ML. Case studies for ML engineering center on the production ML lifecycle: data, training pipeline, serving, deployment, and monitoring.

## Experience Calibration

### Entry Level (0-2 years)
Expect basic end-to-end framing: defining the prediction target, where labeled data comes from, a simple model choice, and an outline of how it would be served and evaluated. Guide them through the deployment and monitoring pieces they miss.

### Mid Level (3-6 years)
Expect production ML thinking: data and labeling strategy, feature pipeline with train/serve consistency, serving architecture with a latency budget, a safe deployment plan, and a drift/retraining loop. Look for trade-off reasoning under real constraints.

### Senior (7+ years)
Expect ML platform-level design: shared feature/serving infrastructure, multi-model orchestration, model governance and rollback, cost-performance trade-offs at scale, and quantified business impact — plus the organizational and reliability dimensions.

## Scoring Emphasis
Evaluate end-to-end framing, data and labeling strategy, feature/serving consistency, serving and latency reasoning, deployment and rollback discipline, drift/monitoring/retraining design, and the ability to tie engineering choices to business and reliability outcomes.

## Red Flags
- Jumps to model architecture without addressing where training data and labels come from
- Designs the model but has no serving, latency, or deployment plan
- No monitoring, drift detection, or retraining story — treats launch as the finish line
- Ignores train/serve consistency and point-in-time correctness in the feature design

## Sample Questions

### Entry Level (0-2 years)
1. "Build a system that scores users for churn every night and stores the predictions. Where do you start?"
   - Targets: pipeline_framing → follow up on: where labels come from and how the job is monitored
2. "Take a working churn model from a notebook and make it serve predictions to a product team. Walk me through it."
   - Targets: productionization → follow up on: serialization, the serving interface, and basic monitoring

### Mid Level (3-6 years)
1. "Design a real-time recommendation pipeline for an e-commerce app with 10M users."
   - Targets: ml_pipeline, serving → follow up on: feature freshness, cold start, and latency budget
2. "Productionize a fraud-scoring model that must return a decision in under 100ms."
   - Targets: realtime_serving → follow up on: train/serve skew, feature fetch, and rollback plan

### Senior (7+ years)
1. "Design an ML platform that lets 50 engineers train, deploy, and monitor models independently."
   - Targets: platform_design, governance → follow up on: feature reuse, experiment tracking, and resource limits
2. "Design a retraining and rollout system for a model that drifts weekly and serves at high traffic."
   - Targets: ml_lifecycle → follow up on: drift triggers, automated retraining, and safe rollout

### All Levels
1. "Your model performs well offline but poorly in production. Walk me through your investigation."
   - Targets: production_debugging → follow up on: train/serve skew, distribution shift, and label delay
