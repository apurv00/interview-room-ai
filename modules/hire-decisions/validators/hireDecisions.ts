import { z } from 'zod'
import {
  HIRE_EXTERNAL_VERDICT_RECOMMENDATIONS,
  HIRE_SHARE_PACKET_SECTIONS,
} from '../types'

const decisionObjectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id')

const sharePacketSectionSchema = z.enum(HIRE_SHARE_PACKET_SECTIONS)

/** Payload for an authenticated member creating a packet; expiry is server policy. */
export const CreateSharePacketSchema = z
  .object({
    allowedSections: z
      .array(sharePacketSectionSchema)
      .min(1)
      .max(HIRE_SHARE_PACKET_SECTIONS.length)
      .superRefine((sections, ctx) => {
        if (new Set(sections).size !== sections.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Each packet section can be selected only once',
          })
        }
      }),
    operationId: z.string().uuid(),
  })
  .strict()

/** A sessionless public capability: workspace id, packet id, and 32-byte hex secret. */
export const SharePacketCapabilitySchema = z
  .string()
  .regex(/^[a-f0-9]{24}\.[a-f0-9]{24}\.[a-f0-9]{64}$/i, 'Invalid share packet capability')

/** An external response deliberately cannot contain scorecard dimensions or evidence. */
export const SubmitExternalVerdictSchema = z
  .object({
    recommendation: z.enum(HIRE_EXTERNAL_VERDICT_RECOMMENDATIONS),
    comment: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict()

/** Query contract for the read-only Phase-4 action inbox. */
export const ReadHireDecisionActionInboxSchema = z
  .object({
    workspaceId: decisionObjectIdSchema,
    jobId: decisionObjectIdSchema.optional(),
    applicationId: decisionObjectIdSchema.optional(),
    externalVerdictsSince: z.coerce.date().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict()

/** Deliberate same-job selection; ordering is preserved by the service. */
export const CompareHireDecisionApplicationsSchema = z
  .object({
    workspaceId: decisionObjectIdSchema,
    jobId: decisionObjectIdSchema,
    applicationIds: z
      .array(decisionObjectIdSchema)
      .min(2)
      .max(3)
      .superRefine((ids, ctx) => {
        if (new Set(ids).size !== ids.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Compare applications must be unique',
          })
        }
      }),
  })
  .strict()

/** Member request; server policy supplies expiry and every private coordinate. */
export const RequestHireAssessmentExportSchema = z
  .object({
    applicationId: decisionObjectIdSchema,
    operationId: z.string().uuid(),
  })
  .strict()

/** Opaque durable identifier used by member status/download endpoints. */
export const HireAssessmentExportIdSchema = decisionObjectIdSchema

export type CreateSharePacketPayload = z.infer<typeof CreateSharePacketSchema>
export type SubmitExternalVerdictPayload = z.infer<typeof SubmitExternalVerdictSchema>
export type ReadHireDecisionActionInboxPayload = z.infer<typeof ReadHireDecisionActionInboxSchema>
export type CompareHireDecisionApplicationsPayload = z.infer<typeof CompareHireDecisionApplicationsSchema>
export type RequestHireAssessmentExportPayload = z.infer<typeof RequestHireAssessmentExportSchema>
