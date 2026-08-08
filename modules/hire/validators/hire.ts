import { z } from 'zod'

export const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id')

export const CreateWorkspaceSchema = z.object({
  name: z.string().trim().min(2).max(120),
})

export const AddMemberSchema = z.object({
  email: z.string().trim().email().max(254),
  name: z.string().trim().min(1).max(120).optional(),
})

export const CreateJobSchema = z.object({
  title: z.string().trim().min(2).max(200),
  jdText: z.string().trim().min(50, 'Job description is too short').max(50000),
})

export const UpdateJobStatusSchema = z
  .object({
    status: z.enum(['open', 'on_hold', 'closed']),
    closeNote: z.string().trim().min(5).max(4000).optional(),
  })
  .refine((d) => d.status !== 'closed' || !!d.closeNote, {
    message: 'A decision note is required when closing a job',
    path: ['closeNote'],
  })

export const AddCandidateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().max(32).optional(),
  resumeText: z.string().max(50000).optional(),
  resumeFileName: z.string().max(255).optional(),
})

export const CreateApplicationSchema = z.object({
  jobId: objectIdSchema,
  candidateId: objectIdSchema,
})

export const MoveStageSchema = z.object({
  action: z.enum(['advance', 'reject']),
  note: z.string().trim().min(1).max(4000).optional(),
})

export const SendAiRoundSchema = z.object({
  experience: z.enum(['0-2', '3-6', '7+']),
  duration: z.union([z.literal(15), z.literal(30)]).default(15),
})

/** Raw invite tokens are 32 random bytes hex-encoded — 64 hex chars exactly. */
const inviteTokenSchema = z.string().regex(/^[a-f0-9]{64}$/i, 'Invalid token')

export const GuestConsentSchema = z.object({ token: inviteTokenSchema })

export const GuestRequestOtpSchema = z.object({
  token: inviteTokenSchema,
  email: z.string().trim().email().max(254),
})

export const GuestVerifyOtpSchema = z.object({
  token: inviteTokenSchema,
  email: z.string().trim().email().max(254),
  code: z.string().regex(/^\d{6}$/, 'Invalid code'),
})

export type CreateWorkspacePayload = z.infer<typeof CreateWorkspaceSchema>
export type AddMemberPayload = z.infer<typeof AddMemberSchema>
export type CreateJobPayload = z.infer<typeof CreateJobSchema>
export type UpdateJobStatusPayload = z.infer<typeof UpdateJobStatusSchema>
export type AddCandidatePayload = z.infer<typeof AddCandidateSchema>
export type CreateApplicationPayload = z.infer<typeof CreateApplicationSchema>
export type MoveStagePayload = z.infer<typeof MoveStageSchema>
export type SendAiRoundPayload = z.infer<typeof SendAiRoundSchema>
export type GuestConsentPayload = z.infer<typeof GuestConsentSchema>
export type GuestRequestOtpPayload = z.infer<typeof GuestRequestOtpSchema>
export type GuestVerifyOtpPayload = z.infer<typeof GuestVerifyOtpSchema>
