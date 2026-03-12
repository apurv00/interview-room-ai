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

export const EDUCATION_LEVELS = [
  'high_school', 'bachelors', 'masters', 'phd', 'bootcamp', 'self_taught',
] as const

export const COMMUNICATION_STYLES = [
  'concise', 'detailed', 'storyteller',
] as const

export const FEEDBACK_PREFERENCES = [
  'encouraging', 'balanced', 'tough_love',
] as const

export const OnboardingUpdateSchema = z.object({
  targetRole: z.string().min(1).max(50).optional(),
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
  // Extended profile fields
  preferredDomains: z.array(z.string().max(50)).max(5).optional(),
  preferredInterviewTypes: z.array(z.string().max(50)).max(6).optional(),
  targetCompanies: z.array(z.string().max(100)).max(5).optional(),
  linkedinUrl: z.string().url().max(200).optional().or(z.literal('')),
  yearsInCurrentRole: z.number().min(0).max(50).optional(),
  educationLevel: z.enum(EDUCATION_LEVELS).optional(),
  topSkills: z.array(z.string().max(50)).max(10).optional(),
  communicationStyle: z.enum(COMMUNICATION_STYLES).optional(),
  feedbackPreference: z.enum(FEEDBACK_PREFERENCES).optional(),
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
