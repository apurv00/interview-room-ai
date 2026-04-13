# Data Science — Coding Interview — Entry Level (0-2 years)

NOTE: DS coding differs from SWE — includes SQL, pandas, statistical computation alongside algorithms.

## Problem Types
- **SQL Queries (40-50%):** Basic-medium JOINs, GROUP BY, aggregations, intro window functions (ROW_NUMBER, RANK), subqueries, date filtering
- **Python/Pandas (30-40%):** DataFrame filtering/sorting, groupby+agg, merge/join, missing values (fillna, dropna), string manipulation, type conversion
- **Basic Statistical Coding (10-20%):** Computing mean/median/std from raw data, simple probability simulation (dice, coins), descriptive statistics
- **Light Algorithmic (0-10%):** Arrays, hashmaps, string manipulation, list comprehensions — easy-to-medium, NOT graph/DP heavy

## Difficulty Level
- SQL: Easy to Medium (DataLemur Easy-Medium)
- Python: Easy to Medium pandas problems
- 1-2 problems in 45-60 minutes
- Python strongly preferred

## Phase Structure (45-60 min)
1. **Clarification (3-5 min):** Read problem, edge cases, expected output format
2. **Approach (5 min):** Brute-force approach, discuss cleaner way
3. **Implementation (25-35 min):** Code with line-by-line explanation
4. **Review/Test (5-10 min):** Walk through with example, check edge cases

## What Makes This Level Unique
- **SQL is eliminatory** — fail SQL, don't reach ML round
- Problems are **well-scoped** with clear inputs/outputs
- **Correctness over optimization** — brute force that works is acceptable
- Must know RANK vs DENSE_RANK vs ROW_NUMBER
- pandas questions often mirror SQL (same logic, different tool)
- **No ML implementation expected** — at most conceptual ML questions separately

## Common DS-Specific Problems (NOT generic DSA)
- "Second highest salary per department" (window functions vs subquery)
- "7-day rolling average of daily revenue" (window frames)
- "Users who purchased on consecutive days" (self-join or LAG)
- "Clean this messy CSV: fix dates, handle nulls, standardize categories" (pandas)
- "Compute correlation between two columns without .corr()" (basic stats)
- "Filter DataFrame: users whose color is green/red AND grade > 90"
- "Returning active users: second purchase within 1-7 days" (Amazon-style)

## Anti-Patterns
- Skipping SQL prep thinking it's "too basic" — SQL is non-negotiable
- Memorizing without understanding; freezing on tweaked questions
- Not explaining code step-by-step
- Endless subqueries when CTE or window function is cleaner
- Forgetting NULL/NaN handling
- Not validating input or clarifying assumptions before coding

## Sources
- InterviewQuery — DS Coding Interview Questions
- DataCamp — DS Interview Questions For All Levels
- StrataScratch — How to Answer DS Coding Questions
- KDnuggets — Top SQL Patterns from FAANG DS Interviews
