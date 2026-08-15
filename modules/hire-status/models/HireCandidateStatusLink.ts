import mongoose, { Document, Model, Schema } from 'mongoose'
import { CANDIDATE_STATUS_LINK_MAX_EXPIRY_DAYS } from '../types'

export const HIRE_CANDIDATE_STATUS_LINK_STATUSES = ['active', 'revoked'] as const
export type HireCandidateStatusLinkStatus = (typeof HIRE_CANDIDATE_STATUS_LINK_STATUSES)[number]

/**
 * Hash-only capability for one candidate's one application. It intentionally
 * contains no candidate name, email, resume, stage, or status snapshot.
 * The only identity metadata is the safe member actor snapshot needed for a
 * future read-only audit projection.
 */
export interface IHireCandidateStatusLink extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  applicationId: mongoose.Types.ObjectId
  jobId: mongoose.Types.ObjectId
  candidateId: mongoose.Types.ObjectId
  /** Immutable safe actor snapshot for the later audit projection. */
  issuedByMemberId: mongoose.Types.ObjectId
  issuedByName: string
  /** Idempotency coordinate for a single issuance attempt. */
  issuanceOperationId: string
  /** SHA-256 of a random 32-byte secret. Never selected by default. */
  secretHash: string
  issuedAt: Date
  expiresAt: Date
  active: boolean
  status: HireCandidateStatusLinkStatus
  revokedAt?: Date
  /** Present only when a member explicitly revoked the link. */
  revokedByMemberId?: mongoose.Types.ObjectId
  revokedByName?: string
  revocationReason?: string
  privacyRedactedAt?: Date
  createdAt: Date
  updatedAt: Date
}

type StatusLinkValidationShape = Pick<
  IHireCandidateStatusLink,
  'active' | 'status' | 'revokedAt' | 'issuedAt' | 'expiresAt'
>

function isQueryValidationContext(value: unknown): boolean {
  return typeof (value as { getUpdate?: unknown })?.getUpdate === 'function'
}

function hasBoundedExpiry(link: StatusLinkValidationShape): boolean {
  if (!(link.issuedAt instanceof Date) || !(link.expiresAt instanceof Date)) return false
  const issuedAt = link.issuedAt.getTime()
  const expiresAt = link.expiresAt.getTime()
  return (
    expiresAt > issuedAt &&
    expiresAt <= issuedAt + CANDIDATE_STATUS_LINK_MAX_EXPIRY_DAYS * 86_400_000
  )
}

function hasValidStatusLinkState(link: StatusLinkValidationShape): boolean {
  if (link.status === 'active') return link.active === true && !link.revokedAt
  return link.status === 'revoked' && link.active === false && link.revokedAt instanceof Date
}

const HireCandidateStatusLinkSchema = new Schema<IHireCandidateStatusLink>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'HireWorkspace',
      required: true,
      immutable: true,
    },
    applicationId: {
      type: Schema.Types.ObjectId,
      ref: 'HireApplication',
      required: true,
      immutable: true,
    },
    jobId: {
      type: Schema.Types.ObjectId,
      ref: 'HireJob',
      required: true,
      immutable: true,
    },
    candidateId: {
      type: Schema.Types.ObjectId,
      ref: 'HireCandidate',
      required: true,
      immutable: true,
    },
    issuedByMemberId: {
      type: Schema.Types.ObjectId,
      ref: 'HireWorkspaceMember',
      required: true,
      immutable: true,
    },
    issuedByName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
      immutable: true,
    },
    issuanceOperationId: {
      type: String,
      required: true,
      maxlength: 80,
      immutable: true,
    },
    // A database read cannot yield a working public link. Lifecycle revocation
    // also unsets this digest as a defense-in-depth invalidation step.
    secretHash: {
      type: String,
      required: true,
      immutable: true,
      select: false,
      match: /^[a-f0-9]{64}$/i,
    },
    issuedAt: { type: Date, required: true, immutable: true },
    expiresAt: {
      type: Date,
      required: true,
      immutable: true,
      validate: {
        validator(this: unknown) {
          const link = this as StatusLinkValidationShape
          return isQueryValidationContext(this) || hasBoundedExpiry(link)
        },
        message: 'Candidate status links must have a bounded future expiry',
      },
    },
    active: { type: Boolean, required: true, default: true },
    status: {
      type: String,
      enum: HIRE_CANDIDATE_STATUS_LINK_STATUSES,
      required: true,
      default: 'active',
      validate: {
        validator(this: unknown) {
          return (
            isQueryValidationContext(this) ||
            hasValidStatusLinkState(this as StatusLinkValidationShape)
          )
        },
        message: 'Candidate status-link lifecycle fields are inconsistent',
      },
    },
    revokedAt: { type: Date },
    revokedByMemberId: {
      type: Schema.Types.ObjectId,
      ref: 'HireWorkspaceMember',
    },
    revokedByName: { type: String, trim: true, maxlength: 120 },
    revocationReason: { type: String, trim: true, maxlength: 160 },
    privacyRedactedAt: { type: Date },
  },
  { timestamps: true, strict: 'throw' },
)

// An issuance retry must never regenerate the raw capability. A later
// intentional reissue uses a new operation id and receives a distinct secret.
HireCandidateStatusLinkSchema.index(
  { workspaceId: 1, applicationId: 1, issuanceOperationId: 1 },
  { unique: true },
)
// Application listing/revocation and privacy/retention sweeps stay tenant-scoped.
HireCandidateStatusLinkSchema.index({
  workspaceId: 1,
  applicationId: 1,
  active: 1,
  expiresAt: 1,
})
HireCandidateStatusLinkSchema.index({
  workspaceId: 1,
  candidateId: 1,
  active: 1,
  expiresAt: 1,
})

export const HireCandidateStatusLink: Model<IHireCandidateStatusLink> =
  mongoose.models.HireCandidateStatusLink ||
  mongoose.model<IHireCandidateStatusLink>('HireCandidateStatusLink', HireCandidateStatusLinkSchema)

export const __hireCandidateStatusLink = {
  hasBoundedExpiry,
  hasValidStatusLinkState,
}
