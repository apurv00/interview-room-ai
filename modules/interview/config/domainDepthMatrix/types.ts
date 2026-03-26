import type { ExperienceLevel } from '@shared/types'

export interface DomainDepthOverride {
  questionStrategy: string
  interviewerTone: string
  technicalTranslation?: string
  scoringEmphasis?: string
  antiPatterns?: string
  experienceCalibration?: Partial<Record<ExperienceLevel, string>>
  domainRedFlags?: string[]
}
