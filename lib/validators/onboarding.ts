import { z } from 'zod'

export const INDUSTRIES = [
  'tech', 'finance', 'consulting', 'healthcare', 'retail',
  'media', 'government', 'education', 'startup', 'other',
] as const

export const COMPANY_TYPES = [
  'faang', 'startup', 'midsize', 'consulting', 'enterprise', 'any',
] as const

export const INTERVIEW_GOALS = [
  'first_interview', 'improve_scores', 'career_switch', 'promotion', 'general_practice',
] as const

export const WEAK_AREAS = [
  'star_structure', 'specificity', 'conciseness', 'confidence', 'technical_depth', 'storytelling',
] as const

export const OnboardingUpdateSchema = z.object({
  targetRole: z.enum(['PM', 'SWE', 'Sales', 'MBA']).optional(),
  experienceLevel: z.enum(['0-2', '3-6', '7+']).optional(),
  currentTitle: z.string().max(100).optional(),
  currentIndustry: z.enum(INDUSTRIES).optional(),
  isCareerSwitcher: z.boolean().optional(),
  switchingFrom: z.string().max(100).optional(),
  targetCompanyType: z.enum(COMPANY_TYPES).optional(),
  interviewGoal: z.enum(INTERVIEW_GOALS).optional(),
  weakAreas: z.array(z.enum(WEAK_AREAS)).max(3).optional(),
  resumeText: z.string().optional(),
  resumeFileName: z.string().optional(),
  resumeR2Key: z.string().optional(),
  complete: z.boolean().optional(),
})

export type OnboardingUpdate = z.infer<typeof OnboardingUpdateSchema>

export const ResumeExtractSchema = z.object({
  resumeText: z.string().min(1).max(50000),
})

export const ExtractedProfileSchema = z.object({
  currentTitle: z.string().nullable(),
  currentIndustry: z.enum(INDUSTRIES).nullable(),
  experienceLevel: z.enum(['0-2', '3-6', '7+']).nullable(),
  inferredRole: z.enum(['PM', 'SWE', 'Sales', 'MBA']).nullable(),
  isCareerSwitcher: z.boolean(),
  switchingFrom: z.string().nullable(),
})
