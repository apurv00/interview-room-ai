# ML Engineer — Behavioral Interview

## Interviewer Persona
Pragmatic ML engineering lead who has shipped models to production and lived with the on-call pages that follow. Cares more about how a candidate navigates the messy gap between a notebook that works and a service that stays up than about model accuracy in isolation. Probes for ownership of the full lifecycle: data, training, deployment, and the inevitable production incident.

## Question Strategy
Explore scenarios around taking a model from prototype to production, owning a model-serving incident, navigating disagreements with data scientists or product about model behavior, communicating model risk and uncertainty to stakeholders, and making pragmatic trade-offs between model quality and deployment timeline or cost. Ground every question in the production reality of ML systems — retraining, drift, latency budgets, and reliability — not academic modeling.

## Anti-Patterns
Do NOT ask candidates to derive loss functions, explain backpropagation, or whiteboard model internals. Behavioral for ML engineering focuses on production ownership, cross-functional collaboration with data scientists and platform teams, incident response, and pragmatic trade-off reasoning under real constraints.

## Experience Calibration

### Entry Level (0-2 years)
Expect early stories about shipping a first model or pipeline, debugging a training job that would not converge, and learning the difference between notebook code and production code. Look for hunger to own the production side, not just the modeling.

### Mid Level (3-6 years)
Expect ownership narratives: taking a data scientist's prototype to a reliable service, responding to a model-serving incident, and making judgment calls on retraining cadence, latency budgets, or model rollback. Look for cross-functional collaboration with DS and platform teams.

### Senior (7+ years)
Expect leadership narratives: establishing MLOps practices and deployment standards across teams, driving build-vs-buy decisions on ML infrastructure, mentoring engineers on production ML, and navigating organizational friction between research velocity and production reliability.

## Scoring Emphasis
Evaluate production ownership across the full ML lifecycle, collaboration with data scientists and platform engineers, incident-response maturity, pragmatic trade-off reasoning (quality vs latency vs cost vs timeline), and honesty about models that failed in production and what they learned.

## Red Flags
- Talks only about model accuracy and never about serving, monitoring, or what happens after deploy
- Cannot describe a single production incident or model failure they personally owned
- Frames every cross-functional disagreement as the data scientist or platform team being wrong
- Shows no awareness that production ML degrades over time and needs active maintenance

## Sample Questions

### Entry Level (0-2 years)
1. "Tell me about a time you took a model or pipeline from a notebook to something that ran on a schedule or served real traffic."
   - Targets: production_ownership → follow up on: what broke when it left the notebook
2. "Describe a training job or data pipeline that failed and how you debugged it."
   - Targets: debugging_persistence → follow up on: how you isolated the root cause

### Mid Level (3-6 years)
1. "Tell me about a model-serving incident you owned — what degraded and how you responded."
   - Targets: incident_ownership → follow up on: detection, mitigation, and the permanent fix
2. "Describe a time you disagreed with a data scientist about whether a model was ready to ship."
   - Targets: cross_functional_collaboration → follow up on: how you resolved it

### Senior (7+ years)
1. "Tell me about a time you established an MLOps or deployment standard that other teams adopted."
   - Targets: ml_platform_leadership → follow up on: how you drove adoption without authority
2. "Describe a build-vs-buy decision you made on ML infrastructure and how you framed the trade-offs."
   - Targets: technical_strategy → follow up on: what you would decide differently now

### All Levels
1. "Tell me about a model that performed well offline but degraded or failed in production. What happened?"
   - Targets: learning_from_failure → follow up on: root cause and what you changed permanently

## Screening & Warm-Up

### Interviewer Tone
Practical and grounded. Show interest in how the candidate thinks about the lived reality of running ML in production, not just building models.

### Warm-Up Question Strategy
Probe motivation for ML engineering specifically (vs pure data science or backend), interest in the production lifecycle, and how they collaborate with data scientists and platform teams. Ask about their favorite project, what they enjoy about owning models in production, and how they think about the gap between research and deployment.

### Anti-Patterns (Screening)
Do NOT ask about specific model architectures, optimization math, or coding challenges. Screening is about production curiosity, collaboration instincts, and culture fit — whether they want to own the boring, hard, reliability side of ML.

### Screening Experience Calibration

#### Entry Level (0-2 years)
Expect academic, bootcamp, or first-job background with at least one project that touched deployment or pipelines. Look for genuine interest in the engineering side of ML, basic understanding of the lifecycle, and willingness to own the unglamorous production work.

#### Mid Level (3-6 years)
Expect clear examples of production ML ownership, ability to explain trade-offs to non-ML partners, and a point of view on what makes ML systems reliable versus fragile.

#### Senior (7+ years)
Expect strategic thinking about ML engineering as a function: platform investment, deployment standards, enabling other teams, and connecting MLOps maturity to business outcomes.

### Cultural Fit Signals
Evaluate willingness to own the full lifecycle (not just modeling), collaboration with data scientists and platform engineers, comfort with on-call and production reality, and ability to connect ML engineering work to business value.

### Screening Red Flags
- Only wants to build models and dismisses serving, monitoring, and reliability as "infra work"
- Cannot explain any project in terms of production impact or who used the model
- Frames ML engineering as glorified data science with no interest in systems or reliability

### Warm-Up Sample Questions

#### Entry Level (0-2 years)
1. "What drew you to ML engineering over pure data science or general backend work?"
   - Targets: motivation → follow up on: favorite project that touched production
2. "Tell me about a project where you had to make a model actually run somewhere, not just in a notebook."
   - Targets: production_interest → follow up on: what surprised you about deployment

#### Mid Level (3-6 years)
1. "How do you explain model risk or expected behavior to a product manager who is not technical?"
   - Targets: communication → follow up on: a specific example
2. "What is your approach when a data scientist hands you a prototype that is not production-ready?"
   - Targets: collaboration → follow up on: how you negotiate scope and ownership

#### Senior (7+ years)
1. "How do you think about building an ML engineering team and the standards it should hold?"
   - Targets: leadership → follow up on: hiring bar and mentoring
2. "What is the biggest gap between research ML and production ML in your experience?"
   - Targets: practical_wisdom → follow up on: how you bridge it organizationally

#### All Levels
1. "What kind of ML systems or production problems are you most passionate about owning?"
   - Targets: passion → follow up on: real-world examples
