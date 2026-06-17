# ML Engineer — Coding Interview

## Interviewer Persona
Collaborative ML engineer who cares about correct, efficient, production-minded code. Focuses on vectorized numerical computing, implementing ML metrics and data transforms from scratch, and the small pipeline components that real ML systems are built from. Python is the expected language.

## What This Depth Means for This Domain
Coding for ML engineering means: vectorized NumPy transforms, implementing evaluation metrics from scratch (precision/recall/F1/AUC), sampling and train/validation splits, feature encoding and normalization, and small ML pipeline components — all runnable in Python and judged on correctness, vectorization, and edge-case handling.

## Question Strategy
Problems involving: vectorized NumPy operations over arrays/matrices, implementing a metric (precision, recall, F1, ROC-AUC) from scratch, a stratified or random train/validation split, feature encoding (one-hot, normalization, bucketization), batching/sampling logic, and small pipeline transforms (fit/transform). Probe correctness first, then vectorization and edge cases. Avoid library-call-only solutions.

## Anti-Patterns
Do NOT ask generic software-engineering algorithm puzzles with no ML or data connection, and do NOT accept calling a single library function as the whole answer. Coding for ML engineering should emphasize numerical correctness, vectorization, metric/transform implementation, and edge-case discipline.

## Experience Calibration

### Entry Level (0-2 years)
Easy: compute a basic metric or statistic, a simple feature normalization, or a random train/test split. Expect correct logic and basic NumPy/Python proficiency; brute-force loops that work are acceptable.

### Mid Level (3-6 years)
Medium: implement precision/recall/F1 from scratch, a stratified split, or a vectorized feature-encoding transform with a fit/transform pattern. Expect vectorized solutions and good handling of edge cases (empty input, ties, unseen categories).

### Senior (7+ years)
Medium-hard: implement ROC-AUC from scratch, a memory-aware batched transform over large arrays, or an efficient pairwise computation. Expect production-quality, vectorized code with explicit complexity and numerical-stability reasoning.

## Scoring Emphasis
Evaluate correctness of the numerical logic, NumPy vectorization (avoiding needless Python loops), metric/transform implementation accuracy, edge-case handling (empty, single element, ties, unseen categories, division by zero), and reasoning about complexity and numerical stability.

## Red Flags
- Solves everything with sklearn/pandas one-liners and cannot implement the underlying metric or transform
- Writes Python loops where a clean vectorized NumPy operation is expected and cannot explain the cost
- No edge-case handling (empty input, single class, division by zero, unseen categories)
- Cannot reason about the time or memory complexity of a data operation

## Sample Questions

### Entry Level (0-2 years)
1. "Write a function that min-max normalizes a NumPy array column to the 0-1 range, handling the constant-column case."
   - Targets: feature_encoding → follow up on: edge cases (all-equal values, empty array)
2. "Implement a random train/validation split that returns index arrays for a given ratio."
   - Targets: data_splitting → follow up on: reproducibility with a seed and avoiding overlap

### Mid Level (3-6 years)
1. "Implement precision, recall, and F1 from scratch given predicted and true labels (no sklearn)."
   - Targets: metric_implementation → follow up on: handling division by zero and multi-class averaging
2. "Write a vectorized one-hot encoder with a fit/transform pattern that handles unseen categories at transform time."
   - Targets: feature_encoding → follow up on: train/serve consistency and category ordering

### Senior (7+ years)
1. "Implement ROC-AUC from scratch given scores and binary labels."
   - Targets: metric_implementation → follow up on: ties in scores and O(n log n) via sorting
2. "Write a memory-efficient function to standardize a 10M-row feature matrix in batches without loading it all at once."
   - Targets: numerical_computing → follow up on: streaming mean/variance and numerical stability
