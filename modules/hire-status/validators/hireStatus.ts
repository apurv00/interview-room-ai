import { z } from 'zod'
import { CANDIDATE_STATUS_LINK_MAX_EXPIRY_DAYS } from '../types'

const statusObjectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid status-link coordinate')

/**
 * A fragment-only, six-part possession capability. The five ObjectId
 * coordinates bind the secret to one exact application and status-link row.
 */
export const CandidateStatusCapabilitySchema = z
  .string()
  .regex(/^(?:[a-f0-9]{24}\.){5}[a-f0-9]{64}$/i, 'Invalid candidate status capability')

/** Member/system request shape. Expiry remains bounded even before a route exists. */
export const IssueCandidateStatusLinkSchema = z
  .object({
    applicationId: statusObjectIdSchema,
    operationId: z.string().uuid(),
    expiresInDays: z.number().int().min(1).max(CANDIDATE_STATUS_LINK_MAX_EXPIRY_DAYS).optional(),
  })
  .strict()

export const CandidateStatusLinkIdSchema = statusObjectIdSchema

export type IssueCandidateStatusLinkPayload = z.infer<typeof IssueCandidateStatusLinkSchema>
