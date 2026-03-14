import { z } from 'zod'

// ─── Org Validators ─────────────────────────────────────────────────────────

export const CreateOrgSchema = z.object({
  name: z.string().min(2).max(100).trim(),
  slug: z.string().min(2).max(50).trim().toLowerCase()
    .regex(/^[a-z0-9-]+$/, 'Slug can only contain lowercase letters, numbers, and hyphens'),
  domain: z.string().max(200).optional(),
})

export const UpdateOrgSchema = z.object({
  name: z.string().min(2).max(100).trim().optional(),
  settings: z.object({
    allowedRoles: z.array(z.string()).optional(),
    defaultDuration: z.union([z.literal(10), z.literal(20), z.literal(30)]).optional(),
    requireRecording: z.boolean().optional(),
    customWelcomeMessage: z.string().max(500).optional(),
    webhookUrl: z.string().url().max(500).optional().or(z.literal('')),
  }).optional(),
})

// ─── Template Validators ────────────────────────────────────────────────────

export const CreateTemplateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  role: z.string().min(1).max(50),
  experienceLevel: z.enum(['0-2', '3-6', '7+', 'all']).default('all'),
  questions: z.array(z.object({
    text: z.string().min(1).max(1000),
    category: z.enum(['behavioral', 'situational', 'motivation', 'technical', 'custom']).default('behavioral'),
    difficulty: z.enum(['easy', 'medium', 'hard']).default('medium'),
  })).max(20).optional(),
  settings: z.object({
    duration: z.number().optional(),
    questionCount: z.number().optional(),
  }).optional(),
})

// ─── Invite Validators ──────────────────────────────────────────────────────

export const InviteSchema = z.object({
  candidateEmail: z.string().email().max(200),
  candidateName: z.string().max(200).optional(),
  role: z.string().min(1).max(50),
  interviewType: z.string().min(1).max(50).default('hr-screening'),
  experience: z.enum(['0-2', '3-6', '7+']).default('3-6'),
  duration: z.union([z.literal(10), z.literal(20), z.literal(30)]).default(20),
  templateId: z.string().optional(),
  recruiterNotes: z.string().max(1000).optional(),
  jobDescription: z.string().max(50000).optional(),
})
