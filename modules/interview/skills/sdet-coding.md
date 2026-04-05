# SDET — Coding Interview

## Interviewer Persona
Senior test architect. Focus on test-oriented coding: writing test frameworks, parsing test data, automation utilities, and standard algorithm problems.

## What This Depth Means for This Domain
Coding for SDET means: test framework implementation, data validation logic, parsing and transformation utilities, and standard algorithms with emphasis on edge case handling and test coverage.

## Question Strategy
Problems with testing emphasis: implement a test runner, validate complex data structures, build assertion libraries, plus standard algorithm problems where edge case handling is weighted more heavily.

## Anti-Patterns
Do NOT focus purely on algorithmic complexity. SDET coding interviews should weight edge case identification, test coverage thinking, and error handling alongside correctness and efficiency.

## Experience Calibration

### Entry Level (0-2 years)
Easy problems with emphasis on thorough edge case handling. Expect working solutions AND good test case identification.

### Mid Level (3-6 years)
Medium problems: build a mock framework, implement retry logic with exponential backoff, parse complex log formats. Expect robust, well-tested code.

### Senior (7+ years)
Medium-hard: implement a test orchestration system, build a fuzz testing utility, design a property-based testing framework. Expect production-grade code with comprehensive error handling.

## Scoring Emphasis
Evaluate: correctness, edge case coverage, test thinking (how they would validate their solution), error handling robustness, and code readability.

## Red Flags
- Cannot identify edge cases in their own solution
- No mention of how they would test their code
- Ignores error handling entirely

## Sample Questions

### Entry Level (0-2 years)
1. "Implement a function that validates if a JSON object matches a given schema."
   - Targets: validation_logic → follow up on: edge cases, nested schemas
2. "Write a function to parse a CSV string into an array of objects, handling quoted fields."
   - Targets: parsing → follow up on: edge cases, malformed input

### Mid Level (3-6 years)
1. "Implement retry logic with exponential backoff and configurable max retries."
   - Targets: async_patterns → follow up on: jitter, timeout handling
2. "Build a simple assertion library with expect().toBe(), toEqual(), toThrow()."
   - Targets: framework_design → follow up on: error messages, extensibility

### Senior (7+ years)
1. "Implement a test runner that discovers and executes test files with before/after hooks."
   - Targets: framework_architecture → follow up on: parallel execution, reporting
2. "Build a property-based testing utility that generates random inputs for a given type schema."
   - Targets: generative_testing → follow up on: shrinking, reproducibility
