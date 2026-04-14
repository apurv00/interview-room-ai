# SDET / QA Engineer — Coding Interview — Entry Level (0-2 years)

## Problem Types
- **Basic DSA (60%):** Arrays, strings, hashmaps, basic sorting/searching. LeetCode Easy to Easy-Medium. Same fundamentals as SWE but at slightly lower bar.
- **Test case writing in code (25%):** Given function signature, write unit tests covering edge cases, boundary values, equivalence partitions. THE distinguishing factor from SWE.
- **Simple automation scripts (10%):** Parse log file, validate CSV data, check API response structure. Python or Java preferred.
- **Basic OOP (5%):** Design simple class (TestResult, BugTracker) with methods.

## Difficulty Level
- DSA: LeetCode Easy, occasionally Easy-Medium (two-sum, reverse linked list, valid parentheses)
- Test-specific: Straightforward — "write tests for this function" or "find the bug"

## Phase Structure (45-60 min)
1. **Warm-up DSA (15-20 min):** One standard algorithm question
2. **Test case design (15-20 min):** Given function or spec, write comprehensive test cases in code (actual assertions, not just a list)
3. **Bug finding / code review (10-15 min):** Read buggy code, identify defects, fix them

## What Makes This Level Unique
- Evaluate whether candidate **thinks in tests** — naturally ask about edge cases, null inputs, boundaries before coding
- Emphasis on **test organization**: setup/teardown even in basic form
- Knowledge of **assertion libraries** (pytest, JUnit, TestNG) expected but not deep framework knowledge
- Often asked to write **both implementation AND tests** — switching between producer/consumer mindsets

## Common SDET-Specific Problems
- "Write function to validate email, then write 10+ test cases for it"
- "Given REST API contract, write test validating response schema"
- "Parse log file, count error occurrences by type"
- "Find all bugs in this code snippet" (off-by-one, null pointer, race condition)
- String manipulation + edge case tests (anagram, palindrome — then test coverage)

## Anti-Patterns
- Tests that only cover happy path
- Not handling null/empty inputs in code or tests
- Tests that depend on execution order
- Hardcoding expected values instead of deriving
- Treating test writing as afterthought

## Sources
- FAANG SDET reports (Amazon SDE-T, Google SET, Microsoft SDET) on LeetCode Discuss, Glassdoor
- "Cracking the Coding Interview" SDET chapter
- TeamBlind SDET interview threads
