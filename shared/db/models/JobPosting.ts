import mongoose, { Schema, Document, Model } from 'mongoose'

/** Sentinel carried only by migrated legacy rows whose complete source set
 * cannot be reconstructed (empty provenance or the old capped array). Any
 * source revoke restricts these rows conservatively. */
export const JOB_SOURCE_LINEAGE_UNKNOWN = '__legacy_unknown__'
export const JOB_SOURCE_ID_PATTERN = /^(?:__legacy_unknown__|[a-z0-9][a-z0-9:_-]{0,99})$/

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
 * userReferenced rows (tracker keeps a stable _id and normally archived
 * canonical JD for owner preparation) and closedReason:'llm-verdict' rows
 * (slimmed to restricted tombstones so the fingerprint keeps blocking scam
 * resurrection; Codex on #504).
 */

export interface IJobProvenance {
  sourceId: string
  externalId: string
  /** `${sourceId}:${externalId}` — the source-tier identity. */
  sourceKey: string
  applyUrl?: string
  applyTier?: 'direct-ats' | 'employer' | 'aggregator-deep' | 'platform-funnel' | 'aggregator-redirect'
  viaSite?: string
  /** §4b crowd-healing: dead-click reports demote this rung for everyone. */
  brokenReportCount?: number
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
  /** Display twin of jdCompressed with block structure preserved
   *  (newlines/bullets — founder item 7, PR-C). NEVER a hash input:
   *  bodyHashOf/verdict/xray hashes all read the collapsed jdCompressed.
   *  Absent on legacy rows — the detail projection falls back. */
  jdDisplayCompressed?: Buffer
  jdLength: number
  parsedJD?: unknown
  /** Normalized-body hash the parsedJD was computed from — a merged JD
   *  replacement changes it and the next X-ray view re-parses (§3.1b). */
  parsedJDHash?: string | null
  /** Role-inference schema + active CMS catalog revision. Requirement IDs
   *  remain stable when only this revision changes. */
  parsedJDRoleVersion?: string | null
  /** Durable, non-evicting legal lineage. Unlike the detailed provenance
   * array below, source IDs must survive dedupe history and tombstone slimming
   * so a later source revoke can always find the canonical row. */
  sourceIds: string[]
  // Detailed provenance (cap 8, eviction preserves source diversity — §4.2 guard #3)
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
  closedReason?: 'board-poll-miss' | 'valid-through-expired' | 'aged-out' | 'llm-verdict' | 'source-revoked' | 'dead-apply-link'
  /** Apply-link liveness (ruling #22): machine-checked by the hourly
   *  link-check sweep; two dead strikes ≥20h apart close the posting. */
  applyCheck?: {
    status: 'dead' | 'alive' | 'unverifiable'
    deadStreak: number
    lastCheckedAt: Date
    lastDeadAt?: Date
  }
  postedAt?: Date
  validThrough?: Date
  /** Canonical source freshness, updated on every insert/merge even when a
   * provider row has no externalId and therefore no provenance entry. */
  lastSeenAt?: Date
  closedAt?: Date
  purgeAt?: Date
  userReferenced: boolean
  /** Consecutive clean board syncs that no longer list this posting (§4.3: 2 → board-poll-miss close). */
  boardPollMisses?: number
  createdAt: Date
  updatedAt: Date
}

const ProvenanceSchema = new Schema<IJobProvenance>(
  {
    sourceId: {
      type: String,
      required: true,
      validate: {
        validator: (sourceId: unknown) => (
          typeof sourceId === 'string' && JOB_SOURCE_ID_PATTERN.test(sourceId)
        ),
        message: 'provenance sourceId must be a canonical durable source identifier',
      },
    },
    externalId: { type: String, required: true },
    sourceKey: { type: String, required: true },
    // Optional: a provider row may carry NO apply link (JSearch rows with
    // neither apply_options nor job_apply_link) — the entry still anchors
    // source identity while a sibling source supplies the apply path.
    // Mongoose treats '' as missing for required strings, so required:true
    // aborted whole batches (Codex on #510).
    applyUrl: { type: String },
    applyTier: { type: String, enum: ['direct-ats', 'employer', 'aggregator-deep', 'platform-funnel', 'aggregator-redirect'] },
    viaSite: { type: String },
    brokenReportCount: { type: Number },
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
    jdDisplayCompressed: { type: Buffer },
    jdLength: { type: Number, default: 0 },
    parsedJD: { type: Schema.Types.Mixed },
    parsedJDHash: { type: String },
    parsedJDRoleVersion: { type: String },
    sourceIds: {
      type: [String],
      required: true,
      default: [],
      validate: {
        validator: (sourceIds: unknown) => (
          Array.isArray(sourceIds) &&
          sourceIds.length > 0 &&
          sourceIds.every((sourceId) => (
            typeof sourceId === 'string' && JOB_SOURCE_ID_PATTERN.test(sourceId)
          ))
        ),
        message: 'sourceIds must contain only canonical durable source identifiers',
      },
    },
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
    closedReason: { type: String, enum: ['board-poll-miss', 'valid-through-expired', 'aged-out', 'llm-verdict', 'source-revoked', 'dead-apply-link'] },
    applyCheck: {
      type: new Schema(
        {
          status: { type: String, enum: ['dead', 'alive', 'unverifiable'], required: true },
          deadStreak: { type: Number, default: 0 },
          lastCheckedAt: { type: Date, required: true },
          lastDeadAt: { type: Date },
        },
        { _id: false }
      ),
    },
    postedAt: { type: Date },
    validThrough: { type: Date },
    lastSeenAt: { type: Date },
    closedAt: { type: Date },
    purgeAt: { type: Date },
    userReferenced: { type: Boolean, default: false },
    boardPollMisses: { type: Number, default: 0 },
  },
  { timestamps: true }
)

// Internal transaction-conflict token for derived Jobs writers. Keeping this
// path out of IJobPosting prevents it becoming part of the product/read
// contract; it is never selected and exists only so an authority-bound write
// conflicts with lifecycle/source-control updates to the same posting.
JobPostingSchema.add({
  derivedAuthorityRevision: { type: Number, default: 0, select: false },
} as never)

// §4.3 serving index budget; no text index. A02's durable lineage indexes on
// `sourceIds` and `provenance.sourceId` are intentionally absent here: normal
// runtime connections allow Mongoose schema automation, which would bypass the
// mandatory rollout gate. `prepare:jobs-source-control-indexes` is their sole
// owner and builds them explicitly before promotion.
// Confidential rows carry no fingerprint by design; a plain unique index
// would reject the second one.
JobPostingSchema.index(
  { fingerprint: 1 },
  { unique: true, partialFilterExpression: { fingerprint: { $type: 'string' } } }
)
JobPostingSchema.index({ 'provenance.sourceKey': 1 }, { unique: true })
JobPostingSchema.index({ companyKey: 1, status: 1 })
JobPostingSchema.index({ domain: 1, locationKeys: 1, status: 1, postedAt: -1 })
// The purgeAt TTL is deliberately NOT schema-owned. Creating it before the
// pre-index lifecycle repair could immediately delete historical rows with a
// stale TTL. `prepare:jobs-retention-index` is its sole, non-dropping owner.
// Verdict sweeper steady-state query (Codex on #504: the sweeper ALSO scans
// for rows missing the sub-doc entirely — that branch is bounded, not indexed).
JobPostingSchema.index(
  { 'llmVerdict.status': 1 },
  { partialFilterExpression: { 'llmVerdict.status': 'pending' } }
)

export const JobPosting: Model<IJobPosting> =
  mongoose.models.JobPosting || mongoose.model<IJobPosting>('JobPosting', JobPostingSchema)
