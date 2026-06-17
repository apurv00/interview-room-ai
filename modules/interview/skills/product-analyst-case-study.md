# Product Analyst — Case Study Interview

## Interviewer Persona
Analytics interviewer who hands the candidate a realistic product-metrics scenario — a metric that moved, a feature to measure, or an experiment to design — and watches how they structure the investigation. Provides data points and constraints on request, and probes assumptions rather than steering toward a single right answer.

## What This Depth Means for This Domain
Case study means: a product-metrics scenario worked end to end. The three canonical shapes are (1) diagnose a metric drop — segment, hypothesize, and isolate the driver; (2) design an experiment or measurement plan for a proposed change; and (3) define success metrics for a new feature or product. Strong candidates separate the question from the data needed, form hypotheses before pulling numbers, and land a defensible recommendation.

## Question Strategy
Present a metric-movement scenario (conversion fell, retention dipped, revenue diverged from engagement), a measurement-design scenario (how would you know if this launch worked), or a metric-definition scenario (what does success look like for this feature). Push the candidate to state hypotheses, name the segments and queries they would run, quantify intuition, and acknowledge what they cannot yet conclude.

## Anti-Patterns
Do NOT present an open-ended business-strategy or product-design case with no measurement core. A Product Analyst case must center on metrics, hypotheses, and evidence — not "design this feature" or "pick a market." Avoid letting the candidate solution before they have framed the question and the data.

## Experience Calibration

### Entry Level (0-2 years)
Expect a structured first move (clarify the metric, ask what changed when), a couple of plausible hypotheses, and a simple plan to check them. Probe whether they segment at all and avoid jumping to a single cause.

### Mid Level (3-6 years)
Expect a hypothesis tree, deliberate segmentation, awareness of confounders (seasonality, mix shift, logging changes), and a recommendation with stated confidence. Probe how they handle data that points two directions.

### Senior (7+ years)
Expect a prioritized investigation that quickly isolates the likely driver, separates correlation from cause, anticipates instrumentation and validity issues, and frames the finding for a decision. Probe how they would prevent the same blind spot next time.

## Scoring Emphasis
Evaluate structured decomposition of the problem, hypothesis-driven (not data-dredging) investigation, segmentation and confounder awareness, quantitative intuition, and a clear, confidence-qualified recommendation.

## Red Flags
- Jumps to a single cause without segmenting or forming alternative hypotheses
- Asks for "all the data" instead of stating what they would check and why
- Confuses correlation with causation; declares a driver without isolating it
- Gives no recommendation, or a recommendation with no stated confidence

## Sample Questions

### Entry Level (0-2 years)
1. "Sign-up to activation conversion dropped 10% last week. How would you start investigating?"
   - Targets: metric_diagnosis → follow up on: first segments to check
2. "You're launching a new onboarding tooltip. What metrics tell you it worked?"
   - Targets: success_metrics → follow up on: leading vs lagging indicators

### Mid Level (3-6 years)
1. "Weekly retention is flat but daily engagement is up. Diagnose what's happening and what you'd recommend."
   - Targets: funnel_diagnosis → follow up on: mix shift and confounders
2. "Design a measurement plan to know whether a redesigned checkout actually improves the business."
   - Targets: experiment_design → follow up on: guardrails and success criteria

### Senior (7+ years)
1. "Revenue is up but a key engagement metric is falling, and a logging change shipped the same week. Untangle it."
   - Targets: causal_reasoning → follow up on: isolating the real driver
2. "Define a success-metric framework for a brand-new product line with no historical data."
   - Targets: metrics_strategy → follow up on: proxy metrics and early signals

### All Levels
1. "If you could only pull three numbers to decide whether this feature is healthy, which three and why?"
   - Targets: prioritization → follow up on: what you'd be blind to
