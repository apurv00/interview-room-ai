import type { AnswerEvaluation } from '@shared/types'

const GENERIC_TIP = 'Keep going — you are doing well.'

function isValidScore(v: unknown): v is number {
  return typeof v === 'number' && !Number.isNaN(v) && v >= 0 && v <= 100
}

/**
 * Derive a one-sentence coaching tip from the evaluation scores.
 * Shown for 3.5 seconds between questions in the COACHING phase.
 *
 * Tie-breaking priority: structure → specificity → ownership → relevance
 * (the order in the `dimensions` array determines priority when scores are equal).
 */
export function deriveCoachingTip(evaluation: AnswerEvaluation): string {
  const { relevance, structure, specificity, ownership } = evaluation

  // Guard: if any score is invalid, return generic tip
  if (
    !isValidScore(relevance) ||
    !isValidScore(structure) ||
    !isValidScore(specificity) ||
    !isValidScore(ownership)
  ) {
    return GENERIC_TIP
  }

  const avg = (relevance + structure + specificity + ownership) / 4

  if (avg >= 70) return 'Great answer! Keep that energy.'
  if (avg < 40) return 'Take a moment to think before answering — structure and examples matter.'

  // Explicit priority order for tie-breaking: structure > specificity > ownership > relevance
  // First in array wins when values are equal (stable sort not guaranteed, so we use find)
  const dimensions = [
    { name: 'structure' as const, value: structure },
    { name: 'specificity' as const, value: specificity },
    { name: 'ownership' as const, value: ownership },
    { name: 'relevance' as const, value: relevance },
  ]

  const minValue = Math.min(...dimensions.map((d) => d.value))
  const weakest = dimensions.find((d) => d.value === minValue)!

  switch (weakest.name) {
    case 'structure':
      return 'Try framing your next answer with Situation, Task, Action, Result.'
    case 'specificity':
      return 'Include specific numbers or metrics in your next answer.'
    case 'ownership':
      return "Use 'I' instead of 'we' to show personal ownership."
    case 'relevance':
      return 'Focus directly on what the question asks.'
    default:
      return GENERIC_TIP
  }
}
