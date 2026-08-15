import mongoose, { Document, Model, Schema } from 'mongoose'
import {
  HIRE_DECISION_DIMENSIONS,
  HIRE_EXTERNAL_VERDICT_RECOMMENDATIONS,
  HIRE_SHARE_PACKET_SECTIONS,
  type HireSharePacketSection,
  type HireSharePacketSnapshot,
} from '../types'

export const HIRE_SHARE_PACKET_STATUSES = [
  'active',
  'verdict_submitted',
  'revoked',
] as const
export type HireSharePacketStatus = (typeof HIRE_SHARE_PACKET_STATUSES)[number]

export interface IHireSharePacket extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  applicationId: mongoose.Types.ObjectId
  jobId: mongoose.Types.ObjectId
  candidateId: mongoose.Types.ObjectId
  /** Workspace-scoped idempotency coordinate for packet creation. */
  creationOperationId: string
  /** SHA-256 of a random 32-byte packet secret. Never selected by default. */
  secretHash: string
  allowedSections: HireSharePacketSection[]
  snapshot: HireSharePacketSnapshot
  active: boolean
  status: HireSharePacketStatus
  expiresAt: Date
  verdictSubmittedAt?: Date
  revokedAt?: Date
  revokedByMemberId?: mongoose.Types.ObjectId
  revokedByName?: string
  revocationReason?: string
  privacyRedactedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const RecommendationTallySchema = new Schema(
  {
    strong_yes: { type: Number, required: true, min: 0 },
    yes: { type: Number, required: true, min: 0 },
    no: { type: Number, required: true, min: 0 },
    strong_no: { type: Number, required: true, min: 0 },
  },
  { _id: false, strict: 'throw' },
)

const DimensionAggregateSchema = new Schema(
  {
    key: { type: String, enum: HIRE_DECISION_DIMENSIONS, required: true, immutable: true },
    count: { type: Number, required: true, min: 0, immutable: true },
    mean: { type: Number, min: 1, max: 5, immutable: true },
    min: { type: Number, min: 1, max: 5, immutable: true },
    max: { type: Number, min: 1, max: 5, immutable: true },
    reviewerSpread: { type: Number, min: 0, max: 4, immutable: true },
  },
  { _id: false, strict: 'throw' },
)

const HumanSourceAggregateSchema = new Schema(
  {
    count: { type: Number, required: true, min: 0, immutable: true },
    recommendations: { type: RecommendationTallySchema, required: true, immutable: true },
    dimensions: {
      type: [DimensionAggregateSchema],
      required: true,
      immutable: true,
      validate: {
        validator(value: unknown[]) {
          return Array.isArray(value) && value.length === HIRE_DECISION_DIMENSIONS.length
        },
        message: 'Human decision summaries require each fixed dimension',
      },
    },
  },
  { _id: false, strict: 'throw' },
)

const HumanScorecardAggregateSchema = new Schema(
  {
    total: { type: HumanSourceAggregateSchema, required: true, immutable: true },
    member: { type: HumanSourceAggregateSchema, required: true, immutable: true },
    kit: { type: HumanSourceAggregateSchema, required: true, immutable: true },
  },
  { _id: false, strict: 'throw' },
)

const CandidateBriefSnapshotSchema = new Schema(
  {
    candidateName: { type: String, required: true, trim: true, maxlength: 120, immutable: true },
    jobTitle: { type: String, required: true, trim: true, maxlength: 200, immutable: true },
    location: { type: String, trim: true, maxlength: 160, immutable: true },
    experienceYears: { type: Number, min: 0, max: 50, immutable: true },
  },
  { _id: false, strict: 'throw' },
)

const AiAssessmentSnapshotSchema = new Schema(
  {
    completedAt: { type: Date, required: true, immutable: true },
    overallScore: { type: Number, min: 0, max: 100, immutable: true },
    recommendation: { type: String, trim: true, maxlength: 120, immutable: true },
    confidence: { type: String, trim: true, maxlength: 120, immutable: true },
    dimensions: {
      type: [
        new Schema(
          {
            key: { type: String, required: true, trim: true, maxlength: 120, immutable: true },
            label: { type: String, trim: true, maxlength: 160, immutable: true },
            score: { type: Number, min: 0, max: 100, immutable: true },
          },
          { _id: false, strict: 'throw' },
        ),
      ],
      required: true,
      immutable: true,
      validate: {
        validator(value: unknown[]) {
          return Array.isArray(value) && value.length <= 64
        },
        message: 'An AI assessment snapshot cannot contain more than 64 dimensions',
      },
    },
  },
  { _id: false, strict: 'throw' },
)

const SharePacketSnapshotSchema = new Schema(
  {
    version: { type: Number, required: true, enum: [1], immutable: true },
    candidateBrief: { type: CandidateBriefSnapshotSchema, immutable: true },
    aiAssessments: {
      type: [AiAssessmentSnapshotSchema],
      immutable: true,
      validate: {
        validator(value: unknown[] | undefined) {
          return value === undefined || (Array.isArray(value) && value.length <= 32)
        },
        message: 'A packet cannot contain more than 32 AI assessment snapshots',
      },
    },
    humanScorecards: { type: HumanScorecardAggregateSchema, immutable: true },
  },
  { _id: false, strict: 'throw' },
)

type SharePacketValidationShape = Pick<
  IHireSharePacket,
  'allowedSections' | 'snapshot' | 'active' | 'status' | 'verdictSubmittedAt' | 'revokedAt'
>

function hasCanonicalSections(sections: HireSharePacketSection[]): boolean {
  return (
    sections.length > 0 &&
    sections.length <= HIRE_SHARE_PACKET_SECTIONS.length &&
    new Set(sections).size === sections.length &&
    sections.every((section) => HIRE_SHARE_PACKET_SECTIONS.includes(section))
  )
}

/** The immutable snapshot must contain exactly the sections the member selected. */
function hasSectionGatedSnapshot(packet: SharePacketValidationShape): boolean {
  if (!hasCanonicalSections(packet.allowedSections)) return false
  const snapshot = packet.snapshot
  if (!snapshot || snapshot.version !== 1) return false
  const allowed = new Set(packet.allowedSections)
  return (
    allowed.has('candidate_brief') === Boolean(snapshot.candidateBrief) &&
    allowed.has('ai_assessments') === Boolean(snapshot.aiAssessments) &&
    allowed.has('human_scorecards') === Boolean(snapshot.humanScorecards)
  )
}

function isQueryValidationContext(value: unknown): boolean {
  return typeof (value as { getUpdate?: unknown })?.getUpdate === 'function'
}

function hasValidPacketState(packet: SharePacketValidationShape): boolean {
  if (packet.status === 'active') {
    return packet.active === true && !packet.verdictSubmittedAt && !packet.revokedAt
  }
  if (packet.status === 'verdict_submitted') {
    return packet.active === false && packet.verdictSubmittedAt instanceof Date && !packet.revokedAt
  }
  return packet.status === 'revoked' && packet.active === false && packet.revokedAt instanceof Date
}

const HireSharePacketSchema = new Schema<IHireSharePacket>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'HireWorkspace', required: true, immutable: true },
    applicationId: { type: Schema.Types.ObjectId, ref: 'HireApplication', required: true, immutable: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'HireJob', required: true, immutable: true },
    candidateId: { type: Schema.Types.ObjectId, ref: 'HireCandidate', required: true, immutable: true },
    creationOperationId: { type: String, required: true, maxlength: 80, immutable: true },
    // A possession capability is generated as 32 random bytes; only the SHA-256
    // digest persists, and even that digest is opt-in for a capability lookup.
    secretHash: {
      type: String,
      required: true,
      immutable: true,
      select: false,
      match: /^[a-f0-9]{64}$/i,
    },
    allowedSections: {
      type: [{ type: String, enum: HIRE_SHARE_PACKET_SECTIONS }],
      required: true,
      immutable: true,
      validate: {
        validator(value: HireSharePacketSection[]) {
          return Array.isArray(value) && hasCanonicalSections(value)
        },
        message: 'Packet sections must be non-empty, unique, and supported',
      },
    },
    snapshot: {
      type: SharePacketSnapshotSchema,
      required: true,
      immutable: true,
      validate: {
        validator(this: unknown) {
          const packet = this as SharePacketValidationShape
          return hasSectionGatedSnapshot(packet)
        },
        message: 'Packet snapshot must match its immutable allowed sections exactly',
      },
    },
    active: { type: Boolean, required: true, default: true },
    status: {
      type: String,
      enum: HIRE_SHARE_PACKET_STATUSES,
      required: true,
      default: 'active',
      validate: {
        validator(this: unknown) {
          // Lifecycle writes use a status CAS. Query validators do not expose
          // the full document state, so enforce the complete invariant for
          // document creation while letting the dedicated packet service make
          // its atomic transition with its explicit state filter.
          return isQueryValidationContext(this) || hasValidPacketState(this as SharePacketValidationShape)
        },
        message: 'Packet active/status lifecycle fields are inconsistent',
      },
    },
    expiresAt: { type: Date, required: true, immutable: true },
    verdictSubmittedAt: { type: Date },
    revokedAt: { type: Date },
    revokedByMemberId: { type: Schema.Types.ObjectId, ref: 'HireWorkspaceMember' },
    revokedByName: { type: String, trim: true, maxlength: 120 },
    revocationReason: { type: String, trim: true, maxlength: 1000 },
    privacyRedactedAt: { type: Date },
  },
  { timestamps: true, strict: 'throw' },
)

HireSharePacketSchema.index({ workspaceId: 1, creationOperationId: 1 }, { unique: true })
HireSharePacketSchema.index({ workspaceId: 1, applicationId: 1, active: 1, expiresAt: 1 })
// Privacy and retention redaction fence by candidate before a snapshot can be retained.
HireSharePacketSchema.index({ workspaceId: 1, candidateId: 1 })

export const HireSharePacket: Model<IHireSharePacket> =
  mongoose.models.HireSharePacket ||
  mongoose.model<IHireSharePacket>('HireSharePacket', HireSharePacketSchema)

export const __hireSharePacket = { hasCanonicalSections, hasSectionGatedSnapshot, hasValidPacketState }
