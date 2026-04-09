import { z } from 'zod'

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const CreateDomainSchema = z.object({
  slug: z.string().min(1).max(100).regex(slugPattern, 'Slug must be lowercase alphanumeric with hyphens'),
  label: z.string().min(1).max(100),
  shortLabel: z.string().max(50).optional(),
  icon: z.string().max(10).optional(),
  description: z.string().max(2000).optional(),
  color: z.string().max(50).optional(),
  category: z.string().max(100).optional(),
  systemPromptContext: z.string().max(5000).optional(),
  sampleQuestions: z.array(z.string().max(500)).max(20).optional(),
  evaluationEmphasis: z.array(z.string().max(200)).max(10).optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
})

export const UpdateDomainSchema = z.object({
  label: z.string().min(1).max(100).optional(),
  shortLabel: z.string().max(50).optional(),
  icon: z.string().max(10).optional(),
  description: z.string().max(2000).optional(),
  color: z.string().max(50).optional(),
  category: z.string().max(100).optional(),
  systemPromptContext: z.string().max(5000).optional(),
  sampleQuestions: z.array(z.string().max(500)).max(20).optional(),
  evaluationEmphasis: z.array(z.string().max(200)).max(10).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
})

const ScoringDimensionSchema = z.object({
  name: z.string().min(1).max(50),
  label: z.string().min(1).max(100),
  weight: z.number().min(0).max(1),
})

export const CreateInterviewTypeSchema = z.object({
  slug: z.string().min(1).max(100).regex(slugPattern, 'Slug must be lowercase alphanumeric with hyphens'),
  label: z.string().min(1).max(100),
  icon: z.string().max(10).optional(),
  description: z.string().max(2000).optional(),
  systemPromptTemplate: z.string().max(5000).optional(),
  questionStrategy: z.string().max(3000).optional(),
  evaluationCriteria: z.string().max(3000).optional(),
  avatarPersona: z.string().max(2000).optional(),
  scoringDimensions: z.array(ScoringDimensionSchema).max(10).optional(),
  applicableDomains: z.array(z.string().max(100)).max(50).optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
})

export const UpdateInterviewTypeSchema = z.object({
  label: z.string().min(1).max(100).optional(),
  icon: z.string().max(10).optional(),
  description: z.string().max(2000).optional(),
  systemPromptTemplate: z.string().max(5000).optional(),
  questionStrategy: z.string().max(3000).optional(),
  evaluationCriteria: z.string().max(3000).optional(),
  avatarPersona: z.string().max(2000).optional(),
  scoringDimensions: z.array(ScoringDimensionSchema).max(10).optional(),
  applicableDomains: z.array(z.string().max(100)).max(50).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
})

// ─── Wizard Config ────────────────────────────────────────────────────────

export const UpdateWizardCostCapSchema = z.object({
  costCapEnabled: z.boolean(),
  costCapUsd: z.number().min(0.01).max(100),
})

// ─── Model Config ─────────────────────────────────────────────────────────

const ModelSlotSchema = z.object({
  taskSlot: z.string().min(1),
  model: z.string().min(1).max(200),
  fallbackModel: z.string().max(200).optional(),
  maxTokens: z.number().int().min(100).max(16000),
  provider: z.enum(['anthropic', 'openrouter']),
  temperature: z.number().min(0).max(2).optional(),
  isActive: z.boolean(),
  useToonInput: z.boolean().optional(),
})

export const UpdateModelConfigSchema = z.object({
  openRouterEnabled: z.boolean(),
  slots: z.array(ModelSlotSchema).max(50),
})
