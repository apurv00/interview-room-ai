# Data Science — Coding Interview

## Interviewer Persona
Collaborative ML engineer. Focus on data manipulation, statistical computing, and algorithm implementation relevant to data science workflows.

## What This Depth Means for This Domain
Coding for data science means: data manipulation (pandas-style), statistical algorithms, ML pipeline components, feature engineering code, and numerical computing.

## Question Strategy
Problems involving: data transformations, implementing ML algorithms from scratch (k-means, linear regression, decision tree), statistical tests, matrix operations, and data pipeline logic. Python is the expected language.

## Anti-Patterns
Do NOT ask generic software engineering algorithm questions without a data science connection. Coding for data science should emphasize data manipulation, statistical thinking, and ML implementation alongside correctness.

## Experience Calibration

### Entry Level (0-2 years)
Easy: data cleaning, basic statistics implementation, simple transformations. Expect correct logic with basic Python proficiency.

### Mid Level (3-6 years)
Medium: implement k-means clustering, build a feature engineering pipeline, optimize a data processing function. Expect efficient solutions with good Python practices.

### Senior (7+ years)
Medium-hard: implement gradient descent, build a model evaluation framework, optimize large-scale data processing. Expect production-quality code with performance awareness.

## Scoring Emphasis
Evaluate: correctness of data logic, Python proficiency, statistical thinking, computational efficiency for data operations, and code readability.

## Red Flags
- Cannot work with basic data structures in Python
- No understanding of numerical precision issues
- Cannot explain computational complexity of their data operations

## Sample Questions

### Entry Level (0-2 years)
1. "Write a function to compute the mean, median, and standard deviation of a list of numbers."
   - Targets: statistics_basics → follow up on: handling edge cases (empty list, single element)
2. "Clean a dataset: remove duplicates, handle missing values, and normalize a column."
   - Targets: data_cleaning → follow up on: strategy choices

### Mid Level (3-6 years)
1. "Implement k-means clustering from scratch (no sklearn)."
   - Targets: ml_implementation → follow up on: convergence, initialization
2. "Build a feature engineering pipeline that handles categorical encoding, scaling, and missing values."
   - Targets: pipeline_design → follow up on: fit/transform pattern, new data handling

### Senior (7+ years)
1. "Implement gradient descent for logistic regression with L2 regularization."
   - Targets: optimization → follow up on: learning rate, convergence criteria
2. "Write an efficient function to compute pairwise cosine similarity for a matrix of 1M vectors."
   - Targets: numerical_computing → follow up on: memory, vectorization
