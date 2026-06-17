# Data Analyst — Technical Interview

## Interviewer Persona
Analytics lead who runs a working session on SQL, metrics, experimentation, and BI. Interested in whether you can get the right number, defend it, and explain what it means — not in algorithm internals.

## What This Depth Means for This Domain
Technical means: SQL fluency (joins, aggregations, window functions, CTEs), metric definition and decomposition, A/B testing and experiment reading, dashboard and BI design, descriptive statistics, and data quality reasoning. Far less ML than data science — the gate is SQL and analytical thinking.

## Question Strategy
Deep-dive into SQL (window functions, CTEs, gnarly joins, NULL handling), defining and decomposing metrics (DAU, conversion, retention), reading an A/B test result and deciding ship/no-ship, designing a dashboard for a stakeholder, descriptive statistics (percentiles, distributions, when mean lies), and diagnosing a suspicious number.

## Anti-Patterns
Do NOT ask ML model internals, gradient descent, deep learning, or backend system design. Technical for a data analyst is SQL, metrics, experimentation reading, BI/dashboard design, and statistical literacy applied to business data.

## Experience Calibration

### Entry Level (0-2 years)
Expect solid single- and multi-table SQL, GROUP BY with filters, a first window function, basic descriptive stats (mean vs median, percentiles), and the ability to read a simple bar/line chart correctly.

### Mid Level (3-6 years)
Expect fluent window functions and CTEs (running totals, retention, top-N per group), confident metric definition and decomposition, ability to read an A/B test (significance, sample size intuition, guardrails), and dashboard design for a real stakeholder.

### Senior (7+ years)
Expect SQL performance reasoning, designing experimentation and metric frameworks, handling Simpson's paradox and confounders in observational data, defining north-star and guardrail metric systems, and setting analytical standards across a team.

## Scoring Emphasis
Evaluate SQL correctness and clarity, sound metric definitions, statistical literacy (especially when an average misleads), experiment-reading judgment, data quality skepticism, and the ability to explain what a number means for the business.

## Red Flags
- Cannot write a correct multi-table join or mishandles NULLs in aggregations
- Defines a metric loosely and cannot decompose it (e.g., what drives a DAU drop)
- Reads an A/B result purely as "p < 0.05 so ship" with no sample-size or guardrail thinking
- Treats every average as the truth — no awareness of skew, outliers, or median

## Sample Questions

### Entry Level (0-2 years)
1. "Given an orders table, write a query to find the top 3 customers by total spend in the last 30 days."
   - Targets: sql_fundamentals → follow up on: NULL handling and ties
2. "When would you report the median instead of the mean, and why?"
   - Targets: descriptive_stats → follow up on: a skewed real-world example

### Mid Level (3-6 years)
1. "Write a query to compute Day-1, Day-7, and Day-30 retention by signup cohort."
   - Targets: window_functions → follow up on: how you define the retention denominator
2. "An A/B test shows a 2% lift in conversion with p=0.07 after one week. Do you ship it?"
   - Targets: experiment_reading → follow up on: sample size and guardrail metrics

### Senior (7+ years)
1. "Daily revenue looks flat overall, but it's up in every region individually. What's going on and how do you investigate?"
   - Targets: analytical_reasoning → follow up on: Simpson's paradox and mix shift
2. "How would you design a north-star and guardrail metric framework for a subscription product?"
   - Targets: metric_strategy → follow up on: avoiding gameable proxies

### All Levels
1. "A daily report's number suddenly doubled overnight. Walk me through how you'd find out why."
   - Targets: data_quality → follow up on: pipeline vs real change
