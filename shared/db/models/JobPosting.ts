import mongoose, { Schema, Document, Model } from 'mongoose'

/**
 * JobPosting — one canonical job in the rolling corpus (INGESTION §4.2/§4.3).
 *
 * Identity is deterministic and LLM-free (ruling #10): `fingerprint` is
 * sha256(companyKey|titleKey|locationKey)[:24], ABSENT for confidential
 * companies (they never merge — hence the partial unique index; a plain
 * unique index would reject the second confidential row).
 *
 * `llmVerdict` (ruling #16) is written ONLY by the async verdict worker when
 * `jobs_llm_verdict` is on — Phase A never writes it; its absence must be
 * byte-identical to today. The verdict only ADDS severity: deterministic
 * `flags`/drops are the permanent floor (ruling #15).
 *
 * Lifecycle: closed on evidence (validThrough past, 2 board-poll misses,
 * 14d lastSeenAt silence), purged 7d after close via the purgeAt TTL — EXCEPT
 * userReferenced rows (tracker keeps a stable _id forever) and
 * closedReason:'llm-verdict' rows (slimmed to tombstones so the fingerprint
 * keeps blocking scam resurrection; Codex on #504).
 */

export interface IJobProvenance {
  sourceId: string
  externalId: string
  /** `${sourceId}:${externalId}` — the source-tier identity. */
  sourceKey: string
  applyUrl: string
  applyTier: 'direct-ats' | 'employer' | 'aggregator-deep' | 'platform-funnel' | 'aggregator-redirect'
  viaSite?: string
  firstSeenAt: Date
  lastSeenAt: Date
}

export interface IJobLlmVerdict {
  status: 'pending' | 'scored'
  verdict?: 'genuine' | 'suspicious' | 'fraud'
  reasonCodes?: string[]
  genuineness?: number
  quality?: number
  completeness?: number
  domain?: string
  domainConfidence?: number
  seniority?: 'fresher' | 'junior' | 'mid' | 'senior' | 'lead' | 'unspecified'
  fresherFriendly?: boolean
  geo?: { locations: string[]; workMode: 'onsite' | 'hybrid' | 'remote' | 'unspecified' }
  /** Full-field-set hash the verdict binds to (spec name, ruling #16) — input change ⇒ re-verdict. */
  verdictInputHash?: string
  /** `${actualModelUsed}:${promptVersion}` — immutable within an epoch. */
  epoch?: string
  model?: string
  promptVersion?: string
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  ranAt?: Date
  attempts: number
  /** ≤300 chars, never contains JD text (ruling #9). */
  lastError?: string
  disagreesWithRules?: boolean
}

export interface IJobPosting extends Document {
  _id: mongoose.Types.ObjectId
  // Identity
  companyKey: string
  titleKey: string
  titleTokens: string[]
  locationKeys: string[]
  fingerprint?: string
  confidentialCompany: boolean
  // Display
  title: string
  company: string
  locations: string[]
  isRemote: boolean
  salaryText?: string
  domain?: string
  // Content
  jdCompressed?: Buffer
  jdLength: number
  parsedJD?: unknown
  // Provenance (cap 8, eviction preserves source diversity — §4.2 guard #3)
  provenance: IJobProvenance[]
  // Quality (deterministic layer — serving consumes as demotions, never hides)
  flags: {
    staffing: boolean
    salaryConflict: boolean
    shortJd: boolean
    repost: boolean
    repostCount: number
  }
  llmVerdict?: IJobLlmVerdict
  // Lifecycle
  status: 'open' | 'closed'
  closedReason?: 'board-poll-miss' | 'valid-through-expired' | 'aged-out' | 'llm-verdict' | 'source-revoked'
  postedAt?: Date
  validThrough?: Date
  closedAt?: Date
  purgeAt?: Date
  userReferenced: boolean
  createdAt: Date
  updatedAt: Date
}

const ProvenanceSchema = new Schema<IJobProvenance>(
  {
    sourceId: { type: String, required: true },
    externalId: { type: String, required: true },
    sourceKey: { type: String, required: true },
    applyUrl: { type: String, required: true },
    applyTier: { type: String, enum: ['direct-ats', 'employer', 'aggregator-deep', 'platform-funnel', 'aggregator-redirect'], required: true },
    viaSite: { type: String },
    firstSeenAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
  },
  { _id: false }
)

const LlmVerdictSchema = new Schema<IJobLlmVerdict>(
  {
    status: { type: String, enum: ['pending', 'scored'], required: true },
    verdict: { type: String, enum: ['genuine', 'suspicious', 'fraud'] },
    reasonCodes: { type: [String], default: undefined },
    genuineness: { type: Number, min: 0, max: 1 },
    quality: { type: Number, min: 0, max: 1 },
    completeness: { type: Number, min: 0, max: 1 },
    domain: { type: String },
    domainConfidence: { type: Number, min: 0, max: 1 },
    seniority: { type: String, enum: ['fresher', 'junior', 'mid', 'senior', 'lead', 'unspecified'] },
    fresherFriendly: { type: Boolean },
    geo: {
      type: new Schema(
        {
          locations: { type: [String], default: [] },
          workMode: { type: String, enum: ['onsite', 'hybrid', 'remote', 'unspecified'], default: 'unspecified' },
        },
        { _id: false }
      ),
    },
    verdictInputHash: { type: String },
    epoch: { type: String },
    model: { type: String },
    promptVersion: { type: String },
    inputTokens: { type: Number },
    outputTokens: { type: Number },
    costUsd: { type: Number },
    ranAt: { type: Date },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, maxlength: 300 },
    disagreesWithRules: { type: Boolean },
  },
  { _id: false }
)

const JobPostingSchema = new Schema<IJobPosting>(
  {
    companyKey: { type: String, required: true },
    titleKey: { type: String, required: true },
    titleTokens: { type: [String], default: [] },
    locationKeys: { type: [String], default: [] },
    fingerprint: { type: String },
    confidentialCompany: { type: Boolean, default: false },
    title: { type: String, required: true, maxlength: 300 },
    company: { type: String, required: true, maxlength: 300 },
    locations: { type: [String], default: [] },
    isRemote: { type: Boolean, default: false },
    salaryText: { type: String, maxlength: 200 },
    domain: { type: String },
    jdCompressed: { type: Buffer },
    jdLength: { type: Number, default: 0 },
    parsedJD: { type: Schema.Types.Mixed },
    provenance: { type: [ProvenanceSchema], default: [] },
    flags: {
      staffing: { type: Boolean, default: false },
      salaryConflict: { type: Boolean, default: false },
      shortJd: { type: Boolean, default: false },
      repost: { type: Boolean, default: false },
      repostCount: { type: Number, default: 0 },
    },
    llmVerdict: { type: LlmVerdictSchema },
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
    closedReason: { type: String, enum: ['board-poll-miss', 'valid-through-expired', 'aged-out', 'llm-verdict', 'source-revoked'] },
    postedAt: { type: Date },
    validThrough: { type: Date },
    closedAt: { type: Date },
    purgeAt: { type: Date },
    userReferenced: { type: Boolean, default: false },
  },
  { timestamps: true }
)

// §4.3 index budget — complete; no text index.
// Confidential rows carry no fingerprint by design; a plain unique index
// would reject the second one.
JobPostingSchema.index(
  { fingerprint: 1 },
  { unique: true, partialFilterExpression: { fingerprint: { $type: 'string' } } }
)
JobPostingSchema.index({ 'provenance.sourceKey': 1 }, { unique: true })
JobPostingSchema.index({ companyKey: 1, status: 1 })
JobPostingSchema.index({ domain: 1, locationKeys: 1, status: 1, postedAt: -1 })
// TTL on the explicit purge timestamp; docs without purgeAt never expire —
// userReferenced and llm-verdict tombstones simply never get one.
JobPostingSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 })
// Verdict sweeper steady-state query (Codex on #504: the sweeper ALSO scans
// for rows missing the sub-doc entirely — that branch is bounded, not indexed).
JobPostingSchema.index(
  { 'llmVerdict.status': 1 },
  { partialFilterExpression: { 'llmVerdict.status': 'pending' } }
)

export const JobPosting: Model<IJobPosting> =
  mongoose.models.JobPosting || mongoose.model<IJobPosting>('JobPosting', JobPostingSchema)
