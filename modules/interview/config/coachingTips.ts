import type { AnswerEvaluation } from '@shared/types'

const GENERIC_TIP = 'Keep going — you are doing well.'

function isValidScore(v: unknown): v is number {
  return typeof v === 'number' && !Number.isNaN(v) && v >= 0 && v <= 100
}

// Domain-specific tip variants keyed by "dimension:interviewType" or "dimension:domain"
const DOMAIN_TIPS: Record<string, string> = {
  // Technical interview tips
  'structure:technical': 'Try explaining your reasoning step-by-step — walk through your thought process.',
  'specificity:technical': 'Be precise with technical terms — mention specific tools, patterns, or metrics.',

  // Case-study tips
  'structure:case-study': 'Start with a framework — state your approach before diving into analysis.',
  'specificity:case-study': 'Ground your analysis in numbers — estimate sizes, percentages, or dollar amounts.',

  // Business domain tips
  'specificity:business': 'Quantify your impact — pipeline numbers, financial metrics, or conversion rates make your answers compelling.',
  'ownership:business': 'Own the outcome — describe your specific actions and how you drove the result.',
  'structure:business': 'Structure your analysis — state assumptions, walk through the model, then give a recommendation.',

  // Behavioral interview tips
  'ownership:behavioral': "Lead with 'I' — describe your specific actions and decisions, not the team's.",
  'structure:behavioral': 'Use the STAR format — set the scene, then walk through your specific actions and the measurable result.',

  // PM domain tips
  'specificity:pm': 'Ground your product decisions in data — mention user metrics, conversion rates, or experiment results.',
  'relevance:pm': 'Tie your answer back to user impact — what problem does this solve and for whom?',

  // Design domain tips
  'specificity:design': 'Reference specific user research findings or usability metrics to support your design decisions.',
  'structure:design': 'Walk through your design process — research, ideation, iteration, and validation.',

}

/**
 * Derive a one-sentence coaching tip from the evaluation scores.
 * Shown for 1.5 seconds between questions in the COACHING phase.
 *
 * Tie-breaking priority: structure → specificity → ownership → relevance
 * (the order in the `dimensions` array determines priority when scores are equal).
 *
 * When domain or interviewType is provided, returns domain-specific tips
 * for more targeted coaching.
 */
export function deriveCoachingTip(
  evaluation: AnswerEvaluation,
  domain?: string,
  interviewType?: string,
): string {
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

  // Try domain-specific tip first (check interviewType, then domain)
  if (interviewType) {
    const typeTip = DOMAIN_TIPS[`${weakest.name}:${interviewType}`]
    if (typeTip) return typeTip
  }
  if (domain) {
    const domainTip = DOMAIN_TIPS[`${weakest.name}:${domain}`]
    if (domainTip) return domainTip
  }

  // Fall back to generic dimension tips
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
