import type { ExperienceLevel } from '@shared/types'

export interface PoolQuestion {
  question: string
  experience: ExperienceLevel | 'all'
  targetCompetency: string
  followUpTheme?: string
}

export type QuestionPool = Record<string, PoolQuestion[]>
