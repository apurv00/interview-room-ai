import { z } from 'zod'

// ─── Shared Sub-schemas ────────────────────────────────────────────────────

export const WizardSegmentEnum = z.enum(['fresh_grad', 'career_changer', 'returning_worker', 'experienced'])
export type WizardSegment = z.infer<typeof WizardSegmentEnum>

const WizardContactInfoSchema = z.object({
  fullName: z.string().min(1).max(200),
  email: z.string().email().max(200),
  phone: z.string().max(30).optional(),
  city: z.string().max(200).optional(),
  linkedInUrl: z.string().max(500).optional(),
})

const WizardRoleSchema = z.object({
  id: z.string(),
  company: z.string().max(200),
  title: z.string().max(200),
  location: z.string().max(200).optional(),
  startDate: z.string().max(50),
  endDate: z.string().max(50).optional(),
  rawBullets: z.array(z.string().max(1000)).max(20),
})

const WizardEducationSchema = z.object({
  id: z.string(),
  institution: z.string().max(200),
  degree: z.string().max(200),
  field: z.string().max(200).optional(),
  graduationDate: z.string().max(50).optional(),
  gpa: z.string().max(10).optional(),
  honors: z.string().max(200).optional(),
})

const WizardSkillsSchema = z.object({
  hard: z.array(z.string().max(100)).max(50),
  soft: z.array(z.string().max(100)).max(50),
  technical: z.array(z.string().max(100)).max(50),
})

const WizardProjectSchema = z.object({
  id: z.string(),
  name: z.string().max(200),
  description: z.string().max(2000),
  technologies: z.array(z.string().max(100)).max(20).optional(),
  url: z.string().max(500).optional(),
})

const WizardCertificationSchema = z.object({
  name: z.string().max(200),
  issuer: z.string().max(200),
  date: z.string().max(50).optional(),
})

// ─── API Schemas ───────────────────────────────────────────────────────────

// POST /api/resume-wizard/session/create
export const CreateWizardSessionSchema = z.object({
  segment: WizardSegmentEnum,
})
export type CreateWizardSessionInput = z.infer<typeof CreateWizardSessionSchema>

// POST /api/resume-wizard/stage/submit (discriminated union by stage)
const Stage1Data = z.object({ stage: z.literal(1), contactInfo: WizardContactInfoSchema })
const Stage2Data = z.object({ stage: z.literal(2), roles: z.array(WizardRoleSchema).min(1).max(10) })
const Stage3Data = z.object({ stage: z.literal(3), education: z.array(WizardEducationSchema).min(1).max(10) })
const Stage4Data = z.object({ stage: z.literal(4), skills: WizardSkillsSchema })
const Stage5Data = z.object({
  stage: z.literal(5),
  projects: z.array(WizardProjectSchema).max(20).optional(),
  certifications: z.array(WizardCertificationSchema).max(20).optional(),
})

export const SubmitStageSchema = z.object({
  sessionId: z.string(),
  data: z.discriminatedUnion('stage', [Stage1Data, Stage2Data, Stage3Data, Stage4Data, Stage5Data]),
})
export type SubmitStageInput = z.infer<typeof SubmitStageSchema>

// POST /api/resume-wizard/follow-ups/generate
export const GenerateFollowUpsSchema = z.object({
  sessionId: z.string(),
  roleId: z.string(),
  jobTitle: z.string().max(200),
  company: z.string().max(200).optional(),
  rawDescription: z.string().max(5000),
})
export type GenerateFollowUpsInput = z.infer<typeof GenerateFollowUpsSchema>

// POST /api/resume-wizard/ai/enhance
export const EnhanceWizardSchema = z.object({
  sessionId: z.string(),
})
export type EnhanceWizardInput = z.infer<typeof EnhanceWizardSchema>

// POST /api/resume-wizard/stage/review/submit
const BulletDecisionSchema = z.object({
  roleId: z.string(),
  bulletIndex: z.number().int().min(0),
  decision: z.enum(['accept', 'reject', 'edit']),
  editedText: z.string().max(1000).optional(),
})

export const ReviewSubmitSchema = z.object({
  sessionId: z.string(),
  bulletDecisions: z.array(BulletDecisionSchema),
  summaryDecision: z.enum(['accept', 'reject', 'edit']),
  editedSummary: z.string().max(2000).optional(),
})
export type ReviewSubmitInput = z.infer<typeof ReviewSubmitSchema>

// POST /api/resume-wizard/export
export const ExportWizardSchema = z.object({
  sessionId: z.string(),
  template: z.string().max(50).optional(),
  format: z.enum(['pdf']).default('pdf'),
})
export type ExportWizardInput = z.infer<typeof ExportWizardSchema>

// GET /api/resume-wizard/session/[sessionId] — no body schema needed
