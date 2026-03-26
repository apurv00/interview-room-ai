import type { ExperienceLevel } from '@shared/types'
import type { PoolQuestion, QuestionPool } from './types'
import { frontendQuestions } from './frontend'
import { backendQuestions } from './backend'
import { sdetQuestions } from './sdet'
import { devopsQuestions } from './devops'
import { dataScienceQuestions } from './dataScience'
import { pmQuestions } from './pm'
import { designQuestions } from './design'
import { businessQuestions } from './business'
import { marketingQuestions } from './marketing'
import { financeQuestions } from './finance'
import { salesQuestions } from './sales'

export type { PoolQuestion, QuestionPool } from './types'

/**
 * Structured question pool with experience-level targeting.
 * 11 domains × 4 depths × 7 questions = 308 curated questions.
 */
export const QUESTION_POOL: QuestionPool = {
  ...frontendQuestions,
  ...backendQuestions,
  ...sdetQuestions,
  ...devopsQuestions,
  ...dataScienceQuestions,
  ...pmQuestions,
  ...designQuestions,
  ...businessQuestions,
  ...marketingQuestions,
  ...financeQuestions,
  ...salesQuestions,
}

/**
 * Select 3 experience-appropriate questions as AI inspiration.
 * Randomized selection ensures variety across sessions.
 */
export function selectQuestionInspiration(
  domain: string,
  depth: string,
  experience: ExperienceLevel,
  excludeTopics?: string[],
): PoolQuestion[] {
  const key = `${domain}:${depth}`
  const pool = QUESTION_POOL[key]
  if (!pool?.length) return []

  // Filter by experience match (exact + 'all')
  let candidates = pool.filter(q => q.experience === experience || q.experience === 'all')

  // Exclude questions overlapping with already-covered topics
  if (excludeTopics?.length) {
    const topicLower = excludeTopics.map(t => t.toLowerCase())
    candidates = candidates.filter(q =>
      !topicLower.some(t => q.question.toLowerCase().includes(t.slice(0, 30)))
    )
  }

  // Shuffle and pick 3
  const shuffled = [...candidates].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, 3)
}
