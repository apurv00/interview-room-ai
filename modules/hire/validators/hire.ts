import { z } from 'zod'
import { INTERVIEW_ROLE_SLUG_MAX_CHARS } from '@shared/interviewContract'
import { HIRE_STAGES } from '../models/HireApplication'
import { HIRE_JOB_STATUSES } from '../models/HireJob'
import {
  HIRE_JOB_DESCRIPTION_SOURCES,
  HIRE_JOB_LEVELS,
  HIRE_WORK_MODES,
} from '../models/HireJobRequirementVersion'
import {
  HIRE_HUMAN_SCORECARD_DIMENSIONS,
  HIRE_HUMAN_SCORECARD_RECOMMENDATIONS,
} from '../models/HireHumanScorecard'
import {
  getHireCloseEmailTemplatePlaceholderError,
  HIRE_CLOSE_EMAIL_TEMPLATE_BODY_MAX_CHARS,
  HIRE_CLOSE_EMAIL_TEMPLATE_SUBJECT_MAX_CHARS,
} from '../emails/jobCloseRejectionEmail'

export const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id')

export const CreateWorkspaceSchema = z.object({
  name: z.string().trim().min(2).max(120),
  companyDescription: z.string().trim().min(10).max(2000),
  guestAuthMode: z.enum(['magic_link', 'otp']).optional(),
})

export const UpdateWorkspaceSettingsSchema = z
  .object({
    guestAuthMode: z.enum(['magic_link', 'otp']).optional(),
    companyDescription: z
      .string()
      .trim()
      .max(2000)
      .refine((value) => value.length === 0 || value.length >= 10, 'Company description is too short')
      .optional(),
    // Temporary request compatibility for an already-deployed browser. New
    // responses and all new UI use `companyDescription`; a legacy write is
    // migrated into the canonical workspace field by the service.
    companyBlurb: z.string().trim().max(2000).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.guestAuthMode !== undefined ||
      value.companyDescription !== undefined ||
      value.companyBlurb !== undefined,
    'Provide at least one workspace setting',
  )

export const AddMemberSchema = z.object({
  email: z.string().trim().email().max(254),
  name: z.string().trim().min(1).max(120),
})

export const TransferWorkspaceAdminSchema = z
  .object({
    operationId: z.string().uuid(),
  })
  .strict()

export const SoftDeleteWorkspaceSchema = z
  .object({
    confirmationName: z.string().trim().min(2).max(120),
    acknowledgePermanentPurge: z.literal(true),
    operationId: z.string().uuid(),
  })
  .strict()

export const RestoreWorkspaceSchema = z
  .object({
    operationId: z.string().uuid(),
  })
  .strict()

export const SelfDeleteHireMemberSchema = z
  .object({
    operationId: z.string().uuid(),
    workspaceConfirmationName: z.string().min(1).max(120).optional(),
    acknowledgeWorkspaceDeletion: z.literal(true).optional(),
  })
  .strict()

const requirementItemSchema = z.string().trim().min(2).max(500)
const responsibilityItemSchema = z.string().trim().min(5).max(300)

const jobDescriptionFields = {
    // The job title doubles as the engine's `role` in AI rounds; the engine
    // contract caps role at 100 chars, so a longer title must be rejected at
    // authoring time, not dead-end the candidate mid-flow.
    title: z.string().trim().min(2).max(INTERVIEW_ROLE_SLUG_MAX_CHARS),
    // Seniority and experience are deliberately independent. Restrict new
    // writes to the reporting taxonomy while legacy requirement versions keep
    // their historical free-text strings in storage.
    level: z.enum(HIRE_JOB_LEVELS),
    // This range is matching context rendered into the JD, not a deterministic
    // screening rule. The optional `screeningSettings.experienceFloorYears`
    // below remains the only hard-exclusion setting.
    targetExperienceRange: z
      .object({
        minYears: z.number().finite().min(0).max(50),
        maxYears: z.number().finite().min(0).max(50),
      })
      .strict()
      .superRefine((value, ctx) => {
        if (value.minYears > value.maxYears) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['minYears'],
            message: 'Minimum experience cannot exceed maximum experience',
          })
        }
      }),
    responsibilities: z.array(responsibilityItemSchema).min(1).max(10),
    mustHaves: z.array(requirementItemSchema).min(1).max(20),
    niceToHaves: z.array(requirementItemSchema).max(20).default([]),
    location: z.string().trim().min(2).max(160),
    workMode: z.enum(HIRE_WORK_MODES),
    compensation: z.string().trim().min(2).max(240).optional(),
} as const

const screeningSettingsSchema = z
  .object({
    location: z.string().trim().min(1).max(160).optional(),
    experienceFloorYears: z.number().finite().min(0).max(50).optional(),
  })
  .strict()

function rejectDuplicateRequirements(
  value: { responsibilities?: string[]; mustHaves: string[]; niceToHaves: string[] },
  ctx: z.RefinementCtx,
) {
    const seen = new Map<string, string>()
    for (const [group, values] of [
      ['mustHaves', value.mustHaves],
      ['niceToHaves', value.niceToHaves],
    ] as const) {
      values.forEach((item, index) => {
        const key = item.toLowerCase().replace(/\s+/g, ' ')
        const previous = seen.get(key)
        if (previous) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [group, index],
            message: `Duplicate requirement already listed in ${previous}`,
          })
        } else {
          seen.set(key, group)
        }
      })
    }

    const responsibilitySeen = new Set<string>()
    const responsibilities = value.responsibilities ?? []
    responsibilities.forEach((item, index) => {
      const key = item.toLowerCase().replace(/\s+/g, ' ')
      if (responsibilitySeen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['responsibilities', index],
          message: 'Duplicate responsibility already listed',
        })
      } else {
        responsibilitySeen.add(key)
      }
    })
}

export const BuildJobDescriptionSchema = z
  .object(jobDescriptionFields)
  .strict()
  .superRefine(rejectDuplicateRequirements)

/** Minimal engine-boundary contract retained for shared producer-limit checks.
 * The workspace API uses CreateStructuredJobSchema below and never accepts
 * this reduced shape for production job creation. */
export const CreateJobSchema = z
  .object({
    title: jobDescriptionFields.title,
    jdText: z.string().trim().min(50, 'Job description is too short').max(50000),
  })
  .strict()

export const CreateStructuredJobSchema = z
  .object({
    ...jobDescriptionFields,
    // Department is intentionally excluded from BuildJobDescriptionSchema:
    // it classifies the requisition for operations tracking, but does not
    // change the immutable scoring contract or require a new JD generation.
    departmentId: objectIdSchema,
    jdText: z.string().trim().min(50, 'Job description is too short').max(50000),
    /** Explicit provenance for the immutable requirement version. */
    jdSource: z.enum(HIRE_JOB_DESCRIPTION_SOURCES).default('ai_generated'),
    screeningSettings: screeningSettingsSchema.optional(),
  })
  .strict()
  .superRefine(rejectDuplicateRequirements)

/** A duplicate must be deliberately placed in an active department. */
export const DuplicateJobSchema = z
  .object({ departmentId: objectIdSchema })
  .strict()

/** Dedicated metadata command; job lifecycle PATCH remains status-only. */
export const UpdateJobDepartmentSchema = z
  .object({ departmentId: objectIdSchema })
  .strict()

function validateCloseEmailTemplatePlaceholders(
  value: string,
  ctx: z.RefinementCtx,
): void {
  const error = getHireCloseEmailTemplatePlaceholderError(value)
  if (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: error })
  }
}

const closeEmailSubjectTemplateSchema = z
  .string()
  .max(HIRE_CLOSE_EMAIL_TEMPLATE_SUBJECT_MAX_CHARS)
  .superRefine((value, ctx) => {
    if (/[\r\n]/.test(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Email subject must not contain line breaks',
      })
    }
    validateCloseEmailTemplatePlaceholders(value, ctx)
  })
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, 'Email subject is required')

const closeEmailBodyTemplateSchema = z
  .string()
  .max(HIRE_CLOSE_EMAIL_TEMPLATE_BODY_MAX_CHARS)
  .superRefine(validateCloseEmailTemplatePlaceholders)
  .transform((value) => value.replace(/\r\n?/g, '\n').trim())
  .refine((value) => value.length > 0, 'Email body is required')

const closeEmailTemplateSchema = z
  .object({
    subject: closeEmailSubjectTemplateSchema,
    body: closeEmailBodyTemplateSchema,
  })
  .strict()

export const UpdateJobStatusSchema = z
  .object({
    status: z.enum(HIRE_JOB_STATUSES),
    expectedStatus: z.enum(HIRE_JOB_STATUSES),
    operationId: z.string().uuid(),
    closeNote: z.string().trim().min(5).max(4000).optional(),
    closeEmailTemplate: closeEmailTemplateSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === 'closed' && !value.closeNote) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A decision note is required when closing a job',
        path: ['closeNote'],
      })
    }
    if (value.status !== 'closed' && value.closeEmailTemplate !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'An email template may only be supplied when closing a job',
        path: ['closeEmailTemplate'],
      })
    }
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

/**
 * Recruiter-only, job-scoped add flow. A source is intentionally implicit:
 * an existing candidate id means talent-pool provenance, while a name/email
 * pair means a manual entry that may merge with an existing workspace record.
 */
export const AddOrMergeJobCandidateSchema = z
  .object({
    candidateId: objectIdSchema.optional(),
    name: z.string().trim().min(1).max(120).optional(),
    email: z.string().trim().email().max(254).optional(),
    phone: z.string().trim().max(32).optional(),
    operationId: z.string().uuid(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.candidateId) {
      if (value.name !== undefined || value.email !== undefined || value.phone !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['candidateId'],
          message: 'Choose a talent-pool candidate or enter a new person, not both',
        })
      }
      return
    }
    if (!value.name) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['name'],
        message: 'Name is required when adding a person manually',
      })
    }
    if (!value.email) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['email'],
        message: 'Email is required when adding a person manually',
      })
    }
  })

export const HIRE_STAGE_REASON_CODES = ['requirements_mismatch', 'position_closed', 'duplicate_application', 'candidate_withdrew', 'role_filled'] as const

export const MoveStageSchema = z
  .object({
    action: z.enum(['advance', 'reject', 'withdraw', 'offer_accepted', 'offer_declined']),
    expectedFrom: z.enum(HIRE_STAGES),
    operationId: z.string().uuid(),
    reasonCode: z.enum(HIRE_STAGE_REASON_CODES).optional(),
    note: z.string().trim().min(1).max(4000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const destructive = value.action === 'reject' || value.action === 'withdraw' || value.action === 'offer_declined'
    if (destructive && !value.reasonCode) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reasonCode'], message: 'Choose a structured decision reason' })
    if (value.note && value.action !== 'offer_accepted') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['note'], message: 'Free-text notes are not accepted for this action' })
    if (value.reasonCode && (value.action === 'advance' || value.action === 'offer_accepted')) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reasonCode'], message: 'This action does not accept a reason code' })
    if (value.reasonCode && ((value.action === 'withdraw' || value.action === 'offer_declined') !== (value.reasonCode === 'candidate_withdrew'))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reasonCode'], message: 'Choose a reason that matches the requested action' })
    if (value.action === 'offer_accepted' && !value.note) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['note'],
        message: 'A decision note is required when accepting an offer',
      })
    }
  })

export const SendAiRoundSchema = z.object({
  experience: z.enum(['0-2', '3-6', '7+']),
  duration: z.union([z.literal(15), z.literal(30)]).default(15),
})

/**
 * The authenticated HR surface chooses the human-round mode explicitly.
 * Guest-kit recipients are supplied by HR; a member-run round deliberately
 * carries no guest credential, email, or engine configuration.
 */
export const CreateHumanRoundSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('guest_kit'),
      interviewerName: z.string().trim().min(1).max(120),
      interviewerEmail: z.string().trim().email().max(254),
      operationId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      mode: z.literal('member_room'),
      operationId: z.string().uuid(),
    })
    .strict(),
])

const HumanScorecardDimensionSchema = z
  .object({
    key: z.enum(HIRE_HUMAN_SCORECARD_DIMENSIONS),
    rating: z.number().int().min(1).max(5),
    evidence: z.string().trim().min(1).max(2000),
  })
  .strict()

/** The fixed, ordered Phase-3 rubric prevents per-interviewer score drift. */
export const SubmitHumanRoundScorecardSchema = z
  .object({
    dimensions: z
      .array(HumanScorecardDimensionSchema)
      .length(HIRE_HUMAN_SCORECARD_DIMENSIONS.length)
      .superRefine((dimensions, ctx) => {
        dimensions.forEach((dimension, index) => {
          if (dimension.key !== HIRE_HUMAN_SCORECARD_DIMENSIONS[index]) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [index, 'key'],
              message: `Expected ${HIRE_HUMAN_SCORECARD_DIMENSIONS[index]}`,
            })
          }
        })
      }),
    recommendation: z.enum(HIRE_HUMAN_SCORECARD_RECOMMENDATIONS),
    overallComment: z.string().trim().min(1).max(4000),
  })
  .strict()

/** Authenticated workspace coordinate plus a 32-byte invite secret. */
const inviteCapabilitySchema = z
  .string()
  .regex(/^[a-f0-9]{24}\.[a-f0-9]{64}$/i, 'Invalid invite capability')

export const HireConsentAcknowledgementsSchema = z
  .object({
    recording: z.literal(true),
    identityPhoto: z.literal(true),
    attentionMonitoring: z.literal(true),
    aiEvaluation: z.literal(true),
  })
  .strict()

/** Body of POST /begin — the link token and explicit acknowledgement of
 * every recorded/processed activity. In magic-link mode this creates the
 * Hire-owned guest session; in OTP mode it triggers mailbox verification. */
export const GuestBeginSchema = z
  .object({
    capability: inviteCapabilitySchema,
    accepted: HireConsentAcknowledgementsSchema,
  })
  .strict()

/** Body of POST /verify — otp mode's second step. */
export const GuestVerifyCodeSchema = z
  .object({
    capability: inviteCapabilitySchema,
    code: z.string().regex(/^\d{6}$/, 'Invalid code'),
    accepted: HireConsentAcknowledgementsSchema,
  })
  .strict()

export type CreateWorkspacePayload = z.infer<typeof CreateWorkspaceSchema>
export type UpdateWorkspaceSettingsPayload = z.infer<typeof UpdateWorkspaceSettingsSchema>
export type AddMemberPayload = z.infer<typeof AddMemberSchema>
export type TransferWorkspaceAdminPayload = z.infer<typeof TransferWorkspaceAdminSchema>
export type SoftDeleteWorkspacePayload = z.infer<typeof SoftDeleteWorkspaceSchema>
export type RestoreWorkspacePayload = z.infer<typeof RestoreWorkspaceSchema>
export type SelfDeleteHireMemberPayload = z.infer<typeof SelfDeleteHireMemberSchema>
export type BuildJobDescriptionPayload = z.infer<typeof BuildJobDescriptionSchema>
export type CreateJobPayload = z.infer<typeof CreateStructuredJobSchema>
export type DuplicateJobPayload = z.infer<typeof DuplicateJobSchema>
export type UpdateJobDepartmentPayload = z.infer<typeof UpdateJobDepartmentSchema>
export type UpdateJobStatusPayload = z.infer<typeof UpdateJobStatusSchema>
export type AddCandidatePayload = z.infer<typeof AddCandidateSchema>
export type CreateApplicationPayload = z.infer<typeof CreateApplicationSchema>
export type AddOrMergeJobCandidatePayload = z.infer<typeof AddOrMergeJobCandidateSchema>
export type MoveStagePayload = z.infer<typeof MoveStageSchema>
export type SendAiRoundPayload = z.infer<typeof SendAiRoundSchema>
export type CreateHumanRoundPayload = z.infer<typeof CreateHumanRoundSchema>
export type SubmitHumanRoundScorecardPayload = z.infer<typeof SubmitHumanRoundScorecardSchema>
export type GuestBeginPayload = z.infer<typeof GuestBeginSchema>
export type GuestVerifyCodePayload = z.infer<typeof GuestVerifyCodeSchema>
