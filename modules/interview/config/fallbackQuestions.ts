// ─── Fallback Interview Questions ────────────────────────────────────────────
// Diverse pool of behavioral questions used when the AI question-generation API
// fails. Prevents the "every question is identical" bug that occurs when a
// single hardcoded fallback string is returned on every API failure.
//
// Each question covers a different behavioral topic so that even in degraded
// mode the interview feels varied and useful.

export const FALLBACK_QUESTIONS: readonly string[] = [
  'Tell me about a challenge you faced recently and how you handled it.',
  'Describe a time when you had to collaborate with a difficult team member. What was the outcome?',
  'Walk me through a situation where you had to learn something new quickly to complete a project.',
  'Tell me about a time you received critical feedback. How did you respond?',
  'Describe a project where things did not go as planned. What did you do to get back on track?',
  'Can you share an example of when you had to make a decision with incomplete information?',
  'Tell me about a time you took initiative on something outside your usual responsibilities.',
  'Describe a situation where you had to prioritize competing deadlines. How did you decide what came first?',
  'Walk me through an accomplishment you are particularly proud of and why it mattered.',
  'Tell me about a time you had to persuade someone to see things from your perspective.',
]

/**
 * Returns the next unused fallback question from the pool.
 * Tracks which questions have been used via the provided Set to avoid repetition.
 * When all questions have been used, resets and starts over.
 */
export function getNextFallbackQuestion(usedIndices: Set<number>): string {
  // Reset if all questions have been used
  if (usedIndices.size >= FALLBACK_QUESTIONS.length) {
    usedIndices.clear()
  }

  for (let i = 0; i < FALLBACK_QUESTIONS.length; i++) {
    if (!usedIndices.has(i)) {
      usedIndices.add(i)
      return FALLBACK_QUESTIONS[i]
    }
  }

  // Shouldn't reach here, but safe default
  return FALLBACK_QUESTIONS[0]
}
