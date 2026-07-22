import type { AnswerEvaluation } from '@shared/types'

export function boundedScore(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n)))
}

function boundedQuestionIndex(value: unknown, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.min(100, Math.round(n)))
}

function clampForFeedback(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(0, maxLength - 27))}\n[truncated for feedback]`
}

function feedbackFlags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((f): f is string => typeof f === 'string')
    .slice(0, 20)
    .map((f) => clampForFeedback(f, 500))
}

export function codeEvaluationToAnswerEvaluation(
  evaluation: Record<string, unknown>,
  problem: { title: string; description: string },
  submission: { code: string; language: string },
  status: AnswerEvaluation['status'] = 'ok',
): AnswerEvaluation {
  const feedback = typeof evaluation.feedback === 'string' ? evaluation.feedback : undefined
  return {
    questionIndex: boundedQuestionIndex(evaluation.questionIndex, 1),
    question: clampForFeedback(`Coding challenge: ${problem.title}. ${problem.description}`, 2000),
    answer: clampForFeedback(submission.code, 10000),
    relevance: boundedScore(evaluation.correctness),
    structure: boundedScore(evaluation.code_quality),
    specificity: boundedScore(evaluation.efficiency),
    ownership: boundedScore(evaluation.edge_cases ?? evaluation.communication),
    primaryGap: 'technical_accuracy',
    primaryStrength: 'code_quality',
    answerSummary: feedback || `Submitted ${submission.language} solution for ${problem.title}.`,
    flags: feedbackFlags(evaluation.flags),
    status,
    probeDecision: { shouldProbe: false },
  }
}

export function designEvaluationToAnswerEvaluation(
  evaluation: Record<string, unknown>,
  problem: { title: string; description: string },
  submission: {
    components: Array<{ label: string }>
    connections: unknown[]
    questionIndex: number
  },
  status: AnswerEvaluation['status'] = 'ok',
): AnswerEvaluation {
  const feedback = typeof evaluation.feedback === 'string' ? evaluation.feedback : undefined
  const componentLabels = submission.components.map((c) => c.label).join(', ')
  return {
    questionIndex: boundedQuestionIndex(evaluation.questionIndex ?? submission.questionIndex, 1),
    question: clampForFeedback(`System design challenge: ${problem.title}. ${problem.description}`, 2000),
    answer: clampForFeedback(
      `Design diagram with ${submission.components.length} components and ${submission.connections.length} connections: ${componentLabels}`,
      10000,
    ),
    relevance: boundedScore(evaluation.requirements_clarity ?? evaluation.architecture),
    structure: boundedScore(evaluation.architecture),
    specificity: boundedScore(evaluation.scalability),
    ownership: boundedScore(evaluation.tradeoffs ?? evaluation.communication),
    primaryGap: 'system_design',
    primaryStrength: 'architecture',
    answerSummary: feedback || `Submitted architecture diagram for ${problem.title}.`,
    flags: feedbackFlags(evaluation.flags),
    status,
    probeDecision: { shouldProbe: false },
  }
}
