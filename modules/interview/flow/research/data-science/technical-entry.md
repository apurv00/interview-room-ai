# Data Science — Technical Interview — Entry Level (0-2 years)

## Topic Sequence (typical order)
1. **Probability fundamentals** — Bayes' theorem, conditional probability, independence, distributions (normal, binomial, Poisson)
2. **Descriptive statistics** — Mean vs median vs mode, standard deviation, percentiles, data summarization
3. **Hypothesis testing basics** — Null/alternative, p-values, significance levels, Type I/II errors, confidence intervals
4. **Central Limit Theorem** — Why it matters, sampling distributions, when it applies
5. **SQL fundamentals** — JOINs, GROUP BY, aggregations, window functions, date filtering, subqueries
6. **Python / Pandas** — DataFrames, merging, groupby, apply, missing values, basic regex
7. **Data visualization** — When bar vs line vs scatter, Matplotlib/Seaborn, choosing chart for audience
8. **Linear regression** — Assumptions (linearity, normality, homoscedasticity, independence), coefficient interpretation, R-squared
9. **Logistic regression** — Binary classification, odds ratios, sigmoid, threshold selection
10. **Basic ML concepts** — Overfitting vs underfitting, bias-variance, train/test split, cross-validation

## Phase Structure
- **Screening (30-45 min):** 1 SQL + 1 Python question at medium difficulty
- **Onsite Round 1 — Statistics (45 min):** Conceptual + applied problems
- **Onsite Round 2 — Coding (45 min):** Python/pandas data manipulation, possibly take-home
- **Onsite Round 3 — ML Concepts (45 min):** Explain algorithms, when to use what, basic evaluation

## What Makes This Level Unique
- **Conceptual understanding > implementation** — "explain p-value in plain English" > "implement gradient descent"
- **SQL is a gating skill** — many screened out here. Focus on aggregations, date filtering, window functions
- Tools expected: Python or R, SQL, Pandas/NumPy, Matplotlib/Seaborn, Scikit-learn
- DS-specific vs SWE: **Less algorithmic coding, more data manipulation and statistical reasoning**
- Feature selection basics tested: filter, wrapper, embedded methods

## Anti-Patterns
- Memorizing formulas without intuition (variance formula without explaining why n-1)
- Confusing correlation with causation (fundamental red flag)
- SQL syntax errors on basic JOINs
- "I always use random forest" (no analytical thinking about model selection)
- Applying linear regression without checking assumptions
- Jumping to modeling without discussing data cleaning

## Probe Patterns
- "Assumptions of linear regression? What if violated?" (foundational depth)
- "100 features, 1000 rows. What's your concern?" (curse of dimensionality)
- "L1 vs L2 regularization in plain English" (conceptual clarity)
- "SQL: second-highest salary per department" (window functions)
- "Model has 99% accuracy on fraud dataset. Good?" (class imbalance)

## Sources
- DataCamp — 29 DS Interview Questions for All Levels
- InterviewBit — 70+ DS Interview Questions (2026)
- NickSingh — 40 Probability & Statistics Questions (FAANG)
- CodeSignal — 30 DS Questions Basic to Senior
