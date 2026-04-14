# Data Science — Coding Interview — Mid Level (3-6 years)

## Problem Types
- **Complex SQL (30-40%):** Multi-table JOINs with CTEs (4+ chained), advanced window functions (LAG/LEAD, NTILE, running totals, moving averages), cohort retention, sessionization, funnel analysis, performance-aware queries. ~70% of Amazon SQL involves multiple tables.
- **ML Algorithm Implementation from Scratch (25-35%):** Logistic regression with gradient descent (sigmoid, cross-entropy, weight updates) in NumPy only. KNN, K-means, linear regression, AUC/ROC computation, decision tree splitting. **No scikit-learn allowed.**
- **Statistical Simulation (15-20%):** Monte Carlo (estimate pi, simulate A/B test power), Pearson correlation from scratch, bootstrap confidence intervals, Type I/II error rate simulation. Common at Google, quant firms.
- **Data Manipulation at Scale (10-20%):** Feature engineering in pandas/NumPy, complex pivots, time series resampling, vectorized vs apply vs iterrows tradeoffs.
- **DSA with DS Flavor (10-15%):** Medium LeetCode applied to data: "efficiently find median in streaming dataset" (heaps). Runtime/space complexity expected.

## Difficulty Level
- SQL: Medium to Hard (DataLemur Medium-Hard)
- Python/ML: Medium — implement known algorithms cleanly in 30-40 min
- 1-2 problems with follow-ups pushing edge cases and optimization

## Phase Structure (45-60 min)
1. **Clarification & Scoping (3-5 min):** More ambiguous — define approach yourself
2. **Approach Discussion (5-8 min):** 2+ approaches, analyze tradeoffs, pick with justification
3. **Implementation (25-35 min):** Clean, modular code with helper functions, edge cases inline
4. **Follow-up Optimization (5-10 min):** "What if 100x larger?", "O(n) instead of O(n²)?", "Add regularization?"
5. **Discussion (2-5 min):** Limitations, alternatives, production implications

## What Makes This Level Unique
- **ML from scratch is the differentiator** — implement without libraries, proving you understand the math
- **Follow-ups are standard** — initial solution is warm-up; interviewer escalates
- **Ambiguity intentional** — problems don't come fully specified
- **Statistical coding** appears much more than junior, especially Google
- CTE + window function combos in ~40% of hard SQL questions
- **Feature engineering in code** — not just "what features" but "write the code"

## Common DS-Specific Problems
- "Implement logistic regression from scratch: sigmoid, binary cross-entropy, gradient descent, predict"
- "K-means: random init, assign to nearest centroid, update, check convergence"
- "AUC-ROC from scratch given true labels and predicted probabilities"
- "Pearson correlation without any library"
- "Monte Carlo: probability A/B test detects 5% lift with N=1000/group"
- "SQL: Cohort retention table — Day-1, Day-7, Day-30 by signup month"
- "SQL: Top 3 products per category by revenue with YoY growth"
- "Feature engineering: from raw event logs, create churn prediction features (recency, frequency, monetary)"

## Anti-Patterns
- Incorrect math in ML implementation (wrong gradient direction, missing sigmoid)
- Over-engineering (full class hierarchy for a 20-line function)
- Focusing on complex models over fundamentals — bias-variance is still #1 asked
- Not discussing tradeoffs when asked
- pandas .apply()/.iterrows() when vectorized ops exist
- No convergence handling in iterative algorithms (infinite loops)

## Sources
- DataInterview — How to Ace DS Coding Interview
- InterviewQuery — Python ML Interview Questions
- GitHub — Machine-Learning-Interviews (alirezadir)
- InterviewNode — ML Tips for Mid/Senior at FAANG
- Let's Data Science — SQL Cohort Retention & Window Functions
