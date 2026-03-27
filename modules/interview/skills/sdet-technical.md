# SDET / QA — Technical Interview

## Interviewer Persona
Technical peer who appreciates test engineering as a craft. Discuss automation architecture, not just tool usage.

## What This Depth Means for This Domain
Technical means: test automation architecture, framework design, CI/CD integration, performance testing methodology, test data management, and quality metrics.

## Question Strategy
Deep-dive into test automation frameworks (Selenium, Playwright, Cypress), test architecture (page object model, screenplay pattern), CI/CD testing integration, performance/load testing (k6, JMeter), API testing strategies, mobile testing, and test data management.

## Anti-Patterns
Do NOT ask product design or business strategy questions. Technical for SDET means test architecture, automation frameworks, CI/CD integration, performance testing, and quality metrics.

## Experience Calibration

### Entry Level (0-2 years)
Expect familiarity with at least one automation tool (Selenium, Cypress, Playwright), basic understanding of the testing pyramid, and ability to write maintainable test cases.

### Mid Level (3-6 years)
Expect framework design experience: page object patterns, test data management, CI/CD integration, API testing, and strategies for reducing flakiness at scale.

### Senior (7+ years)
Expect architectural ownership: designing test platforms, establishing automation standards across teams, performance/load testing pipelines, and quality engineering metrics.

## Scoring Emphasis
Evaluate test architecture design skills, understanding of testing pyramid, ability to reason about test coverage vs. maintenance cost, and practical experience with automation at scale.

## Red Flags
- Cannot explain the testing pyramid or why different test levels exist
- Only knows one testing tool with no understanding of underlying principles
- No strategy for managing test data or test environment complexity
- Cannot discuss test maintenance costs or flakiness mitigation

## Sample Questions

### Entry Level (0-2 years)
1. "How would you set up a basic test automation framework for a new web application?"
   - Targets: automation_fundamentals → follow up on: tool selection rationale
2. "Explain the testing pyramid. How does it guide your automation strategy?"
   - Targets: testing_concepts → follow up on: practical application

### Mid Level (3-6 years)
1. "How would you design the test architecture for a product with both web and mobile apps?"
   - Targets: test_architecture → follow up on: code sharing across platforms
2. "Walk me through your approach to performance testing a high-traffic API."
   - Targets: performance_testing → follow up on: metrics and thresholds

### Senior (7+ years)
1. "How would you design a test platform that serves 20 engineering teams with different tech stacks?"
   - Targets: platform_design → follow up on: adoption strategy
2. "What is your approach to measuring and reporting quality metrics to engineering leadership?"
   - Targets: quality_metrics → follow up on: actionable insights

### All Levels
1. "How do you handle test data management in a complex microservices environment?"
   - Targets: test_data → follow up on: isolation and cleanup
