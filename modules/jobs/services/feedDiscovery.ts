import crypto from 'crypto'
import mongoose, { type PipelineStage } from 'mongoose'
import { JobPosting, type IJobPosting } from '@shared/db/models'
import {
  FEED_FRESHNESS_DAYS,
  FEED_RESULT_CAP,
  type FeedExperience,
  type FeedSort,
  type PublicFeedQuery,
} from '../config/feedDiscovery'
import { roleToJobsDomain } from '../config/domains'
import { companyKey, locationKey, titleTokens } from './identityResolver'

const PAGE_SIZE_DEFAULT = 20
const PAGE_SIZE_MAX = 50
const CURSOR_VERSION = 4
const CURSOR_MAX_CHARS = 512
const CURSOR_MAX_AGE_MS = 6 * 60 * 60 * 1_000
const CURSOR_FUTURE_SKEW_MS = 5 * 60 * 1_000
const CURSOR_IV_BYTES = 12
const CURSOR_AUTH_TAG_BYTES = 16
const AGGREGATION_MAX_TIME_MS = 3_000
const DAY_MS = 24 * 60 * 60 * 1_000
const RECENCY_WINDOW_DAYS = 21
const RECENCY_MAX = 25
const TARGET_DOMAIN_BONUS = 100
const TARGET_TITLE_BONUS = 60
const RESUME_SKILL_BONUS = 8
const RESUME_SKILL_CAP = 3
const TARGET_TITLE_JACCARD = 0.5

const ENTRY_TITLE_TOKENS = ['intern', 'internship', 'trainee', 'apprentice', 'fresher', 'graduate', 'junior', 'jr']
const SENIOR_TITLE_TOKENS = ['senior', 'sr', 'lead', 'principal', 'staff', 'head', 'director', 'vp', 'vice']

interface FeedDiscoveryQuery extends PublicFeedQuery {
  /** Private role preference. It changes Best-match order, never eligibility. */
  roleDomain?: string
  /** Private target intent. Only bounded normalized tokens enter aggregation. */
  targetRole?: string
  /** Private resume evidence. Only bounded normalized tokens enter aggregation. */
  skills?: string[]
}

interface NormalizedDiscoveryQuery {
  domain?: string
  roleDomain?: string
  targetRoleTokens: string[]
  skillSignals: string[]
  search?: string
  searchTokens: string[]
  searchCompanyKey?: string
  searchDomain?: string
  locationKey?: string
  remote?: PublicFeedQuery['remote']
  experience?: FeedExperience
  companyKey?: string
  freshness?: PublicFeedQuery['freshness']
  sort: FeedSort
}

interface FeedCursorPayload {
  v: typeof CURSOR_VERSION
  h: string
  a: number
  p: number
  s: number
  t: number
  i: string
}

export type FeedDiscoveryRow = Pick<
  IJobPosting,
  | '_id'
  | 'title'
  | 'titleTokens'
  | 'company'
  | 'locations'
  | 'locationKeys'
  | 'isRemote'
  | 'domain'
  | 'postedAt'
  | 'salaryText'
  | 'provenance'
  | 'flags'
  | 'confidentialCompany'
> & {
  personalizationScore: number
  discoveryScore: number
  sortPostedAt: Date
  locationPreferenceMatched: boolean
}

export interface FeedDiscoveryPage {
  rows: FeedDiscoveryRow[]
  pageSize: number
  total: number
  accessibleTotal: number
  resultCap: number
  capped: boolean
  hasNext: boolean
  hasPrevious: boolean
  nextCursor?: string
  previousCursor?: string
  sort: FeedSort
}

export class InvalidFeedCursorError extends Error {
  constructor() {
    super('Invalid or expired Jobs feed cursor')
    this.name = 'InvalidFeedCursorError'
  }
}

function cleanText(value: string | undefined, max: number): string | undefined {
  const cleaned = value?.trim().replace(/\s+/g, ' ').slice(0, max)
  return cleaned || undefined
}

function boundedPrivateTokens(values: string[], limit: number): string[] {
  const tokens = new Set<string>()
  for (const value of values) {
    for (const token of titleTokens(value)) tokens.add(token)
  }
  return Array.from(tokens).sort().slice(0, limit)
}

function boundedSkillSignals(values: string[], limit: number): string[] {
  const signals = new Set<string>()
  for (const value of values) {
    const normalized = cleanText(value, 40)?.toLowerCase()
    if (normalized) signals.add(normalized)
  }
  return Array.from(signals).sort().slice(0, limit)
}

function normalizeDiscoveryQuery(query: FeedDiscoveryQuery): NormalizedDiscoveryQuery {
  const search = cleanText(query.search, 80)
  const location = cleanText(query.location, 80)
  const company = cleanText(query.company, 100)
  const normalizedLocation = location ? locationKey(location) : undefined
  const sort = query.sort ?? 'best'
  const targetRole = sort === 'best' ? cleanText(query.targetRole, 80) : undefined
  return {
    domain: cleanText(query.domain, 50),
    roleDomain: sort === 'best' ? cleanText(query.roleDomain, 50) : undefined,
    targetRoleTokens: targetRole ? boundedPrivateTokens([targetRole], 8) : [],
    skillSignals: sort === 'best' ? boundedSkillSignals(query.skills ?? [], 20) : [],
    search,
    searchTokens: search ? titleTokens(search).slice(0, 8) : [],
    searchCompanyKey: search ? companyKey(search) || undefined : undefined,
    searchDomain: search ? roleToJobsDomain(search) : undefined,
    locationKey: normalizedLocation && normalizedLocation !== 'unknown' ? normalizedLocation : undefined,
    remote: query.remote,
    experience: query.experience,
    companyKey: company ? companyKey(company) || undefined : undefined,
    freshness: query.freshness,
    sort,
  }
}

function queryFingerprint(query: NormalizedDiscoveryQuery, pageSize: number): string {
  const canonical = JSON.stringify({
    domain: query.domain ?? '',
    roleDomain: query.roleDomain ?? '',
    targetRoleTokens: query.targetRoleTokens,
    skillSignals: query.skillSignals,
    searchTokens: query.searchTokens,
    searchCompanyKey: query.searchCompanyKey ?? '',
    searchDomain: query.searchDomain ?? '',
    locationKey: query.locationKey ?? '',
    remote: query.remote ?? '',
    experience: query.experience ?? '',
    companyKey: query.companyKey ?? '',
    freshness: query.freshness ?? '',
    sort: query.sort,
    pageSize,
  })
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 20)
}

function cursorSecret(): string {
  // NEXTAUTH_SECRET is boot-required in production. Domain separation keeps
  // feed cursor encryption independent from auth token formats.
  const configured = process.env.NEXTAUTH_SECRET?.trim()
  if (configured && (process.env.NODE_ENV !== 'production' || configured.length >= 16)) {
    return configured
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('NEXTAUTH_SECRET must be configured with at least 16 characters for Jobs feed cursors')
  }
  return 'dev-only-jobs-feed-cursor-secret'
}

function cursorEncryptionKey(): Buffer {
  return crypto.createHash('sha256')
    .update(`jobs-feed-cursor-encryption:v${CURSOR_VERSION}\0`)
    .update(cursorSecret())
    .digest()
}

function decodeCursorPart(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new InvalidFeedCursorError()
  try {
    return Buffer.from(value, 'base64url')
  } catch {
    throw new InvalidFeedCursorError()
  }
}

function parseCursor(token: string, expectedHash: string, now: Date): FeedCursorPayload {
  if (!token || token.length > CURSOR_MAX_CHARS) throw new InvalidFeedCursorError()
  const parts = token.split('.')
  if (parts.length !== 3 || parts.some((part) => !part)) throw new InvalidFeedCursorError()
  const iv = decodeCursorPart(parts[0])
  const ciphertext = decodeCursorPart(parts[1])
  const authTag = decodeCursorPart(parts[2])
  if (
    iv.length !== CURSOR_IV_BYTES ||
    authTag.length !== CURSOR_AUTH_TAG_BYTES ||
    ciphertext.length === 0
  ) {
    throw new InvalidFeedCursorError()
  }
  let value: unknown
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', cursorEncryptionKey(), iv)
    decipher.setAAD(Buffer.from(`jobs-feed-cursor:v${CURSOR_VERSION}`))
    decipher.setAuthTag(authTag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    value = JSON.parse(plaintext.toString('utf8'))
  } catch {
    throw new InvalidFeedCursorError()
  }
  if (!value || typeof value !== 'object') throw new InvalidFeedCursorError()
  const cursor = value as Record<string, unknown>
  const snapshotAt = cursor.a
  const personalizationScore = cursor.p
  const score = cursor.s
  const postedAt = cursor.t
  const id = cursor.i
  if (
    Object.keys(cursor).length !== 7 ||
    cursor.v !== CURSOR_VERSION ||
    typeof cursor.h !== 'string' ||
    cursor.h !== expectedHash ||
    typeof snapshotAt !== 'number' ||
    !Number.isFinite(snapshotAt) ||
    snapshotAt > now.getTime() + CURSOR_FUTURE_SKEW_MS ||
    snapshotAt < now.getTime() - CURSOR_MAX_AGE_MS ||
    typeof personalizationScore !== 'number' ||
    !Number.isFinite(personalizationScore) ||
    !Number.isInteger(personalizationScore) ||
    personalizationScore < 0 ||
    personalizationScore > 1_000 ||
    typeof score !== 'number' ||
    !Number.isFinite(score) ||
    score < -1_000 ||
    score > 1_000 ||
    typeof postedAt !== 'number' ||
    !Number.isFinite(postedAt) ||
    postedAt < 0 ||
    postedAt > 4_102_444_800_000 ||
    typeof id !== 'string' ||
    !mongoose.isValidObjectId(id)
  ) {
    throw new InvalidFeedCursorError()
  }
  return {
    v: CURSOR_VERSION,
    h: expectedHash,
    a: snapshotAt,
    p: personalizationScore,
    s: score,
    t: postedAt,
    i: id,
  }
}

function encodeCursor(
  row: FeedDiscoveryRow,
  hash: string,
  snapshotAt: Date,
): string {
  const payload: FeedCursorPayload = {
    v: CURSOR_VERSION,
    h: hash,
    a: snapshotAt.getTime(),
    p: Number(row.personalizationScore) || 0,
    s: Number(row.discoveryScore) || 0,
    t: new Date(row.sortPostedAt).getTime(),
    i: String(row._id),
  }
  const iv = crypto.randomBytes(CURSOR_IV_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', cursorEncryptionKey(), iv)
  cipher.setAAD(Buffer.from(`jobs-feed-cursor:v${CURSOR_VERSION}`))
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()
  return [
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    authTag.toString('base64url'),
  ].join('.')
}

function experienceMatchExpression(experience: FeedExperience | undefined): Record<string, unknown> | boolean {
  if (!experience) return false
  const tokens = { $ifNull: ['$titleTokens', []] }
  const senior = { $gt: [{ $size: { $setIntersection: [tokens, SENIOR_TITLE_TOKENS] } }, 0] }
  const entry = { $gt: [{ $size: { $setIntersection: [tokens, ENTRY_TITLE_TOKENS] } }, 0] }
  if (experience === 'senior') return senior
  if (experience === 'entry') return { $and: [{ $not: [senior] }, entry] }
  return { $and: [{ $not: [senior] }, { $not: [entry] }] }
}

function buildBaseMatch(query: NormalizedDiscoveryQuery, snapshotAt: Date): Record<string, unknown> {
  const match: Record<string, unknown> = { status: 'open' }
  const snapshotObjectId = mongoose.Types.ObjectId.createFromTime(
    Math.floor(snapshotAt.getTime() / 1_000) + 1,
  )
  const clauses: Record<string, unknown>[] = [
    {
      $or: [
        { createdAt: { $lte: snapshotAt } },
        {
          $and: [
            { createdAt: { $exists: false } },
            { _id: { $lt: snapshotObjectId } },
          ],
        },
      ],
    },
    {
      // Future or malformed provider timestamps are quarantined before the
      // indexed newest sort/top-400 window. Missing dates remain eligible and
      // naturally sort last; a bad future value must never displace real jobs.
      $or: [
        { postedAt: { $type: 'date', $lte: snapshotAt } },
        { postedAt: null },
      ],
    },
  ]
  if (query.domain) match.domain = query.domain
  if (query.remote) match.isRemote = query.remote === 'remote'
  if (query.companyKey) {
    clauses.push({ companyKey: query.companyKey })
  }
  if (query.freshness) {
    match.postedAt = {
      $gte: new Date(snapshotAt.getTime() - FEED_FRESHNESS_DAYS[query.freshness] * DAY_MS),
      $lte: snapshotAt,
    }
  }
  if (query.search) {
    const searchChoices: Record<string, unknown>[] = []
    if (query.searchTokens.length) searchChoices.push({ titleTokens: { $all: query.searchTokens } })
    if (query.searchCompanyKey) {
      searchChoices.push({ companyKey: query.searchCompanyKey })
    }
    if (query.searchDomain) searchChoices.push({ domain: query.searchDomain })
    if (searchChoices.length) clauses.push({ $or: searchChoices })
  }
  if (clauses.length) match.$and = clauses
  return match
}

function discoveryScoreExpression(query: NormalizedDiscoveryQuery, snapshotAt: Date): Record<string, unknown> {
  const recency = {
    $let: {
      vars: { ageMs: { $subtract: [snapshotAt, '$sortPostedAt'] } },
      in: {
        $cond: [
          {
            $and: [
              { $gte: ['$$ageMs', 0] },
              { $lt: ['$$ageMs', RECENCY_WINDOW_DAYS * DAY_MS] },
            ],
          },
          {
            $multiply: [
              RECENCY_MAX,
              { $subtract: [1, { $divide: ['$$ageMs', RECENCY_WINDOW_DAYS * DAY_MS] }] },
            ],
          },
          0,
        ],
      },
    },
  }
  const titleSearchMatch = query.searchTokens.length
    ? { $setIsSubset: [query.searchTokens, { $ifNull: ['$titleTokens', []] }] }
    : false
  const companySearchMatch = query.searchCompanyKey
    ? { $eq: [{ $ifNull: ['$companyKey', ''] }, query.searchCompanyKey] }
    : false
  const locationMatch = query.locationKey
    ? { $in: [query.locationKey, { $ifNull: ['$locationKeys', []] }] }
    : false
  return {
    $add: [
      recency,
      { $cond: [titleSearchMatch, 80, 0] },
      { $cond: [companySearchMatch, 40, 0] },
      { $cond: [query.searchDomain ? { $eq: ['$domain', query.searchDomain] } : false, 60, 0] },
      { $cond: [locationMatch, 25, 0] },
      { $cond: [experienceMatchExpression(query.experience), 15, 0] },
      { $cond: ['$flags.staffing', -10, 0] },
      { $cond: ['$flags.shortJd', -8, 0] },
      { $cond: ['$flags.repost', -6, 0] },
      { $cond: ['$confidentialCompany', -4, 0] },
    ],
  }
}

function personalizationScoreExpression(query: NormalizedDiscoveryQuery): Record<string, unknown> | number {
  if (!query.roleDomain && !query.targetRoleTokens.length && !query.skillSignals.length) return 0
  const postingTokens = { $setUnion: [{ $ifNull: ['$titleTokens', []] }, []] }
  const targetIntersection = {
    $size: { $setIntersection: [postingTokens, query.targetRoleTokens] },
  }
  const targetUnion = {
    $size: { $setUnion: [postingTokens, query.targetRoleTokens] },
  }
  const targetTitleMatch = query.targetRoleTokens.length
    ? {
        $gte: [
          {
            $divide: [
              targetIntersection,
              targetUnion,
            ],
          },
          TARGET_TITLE_JACCARD,
        ],
      }
    : false
  const skillMatches = query.skillSignals.length
    ? {
        $min: [
          {
            $add: query.skillSignals.map((skill) => ({
              $cond: [
                {
                  $or: [
                    { $in: [skill, postingTokens] },
                    ...(skill.length >= 3
                      ? [{ $gte: [{ $indexOfCP: [{ $toLower: { $ifNull: ['$title', ''] } }, skill] }, 0] }]
                      : []),
                  ],
                },
                1,
                0,
              ],
            })),
          },
          RESUME_SKILL_CAP,
        ],
      }
    : 0
  return {
    $add: [
      { $cond: [query.roleDomain ? { $eq: ['$domain', query.roleDomain] } : false, TARGET_DOMAIN_BONUS, 0] },
      { $cond: [targetTitleMatch, TARGET_TITLE_BONUS, 0] },
      { $multiply: [skillMatches, RESUME_SKILL_BONUS] },
    ],
  }
}

function cursorMatch(
  cursor: FeedCursorPayload,
  sort: FeedSort,
  direction: 'after' | 'before',
): Record<string, unknown> {
  const comparison = direction === 'after' ? '$lt' : '$gt'
  const postedAt = new Date(cursor.t)
  const id = new mongoose.Types.ObjectId(cursor.i)
  if (sort === 'newest') {
    return {
      $or: [
        { sortPostedAt: { [comparison]: postedAt } },
        { sortPostedAt: postedAt, _id: { [comparison]: id } },
      ],
    }
  }
  return {
    $or: [
      { personalizationScore: { [comparison]: cursor.p } },
      { personalizationScore: cursor.p, discoveryScore: { [comparison]: cursor.s } },
      { personalizationScore: cursor.p, discoveryScore: cursor.s, sortPostedAt: { [comparison]: postedAt } },
      { personalizationScore: cursor.p, discoveryScore: cursor.s, sortPostedAt: postedAt, _id: { [comparison]: id } },
    ],
  }
}

function databaseSort(sort: FeedSort, direction: 'after' | 'before'): Record<string, 1 | -1> {
  const descending = direction === 'after'
  if (sort === 'newest') {
    return { sortPostedAt: descending ? -1 : 1, _id: descending ? -1 : 1 }
  }
  return {
    personalizationScore: descending ? -1 : 1,
    discoveryScore: descending ? -1 : 1,
    sortPostedAt: descending ? -1 : 1,
    _id: descending ? -1 : 1,
  }
}

/**
 * Database-backed, creation-fenced live discovery. The cursor freezes the
 * request-time recency clock and excludes later inserts; existing live rows
 * may still close or receive corrected facts between pages. The hard 25k
 * retained-corpus rail and maxTimeMS keep this appropriate for self-hosted
 * Mongo without Atlas Search. Public soft preferences plus private target
 * role/title and resume-title evidence change ordering, never eligibility.
 */
export async function discoverFeed(
  input: FeedDiscoveryQuery,
  now = new Date(),
  requestedPageSize = PAGE_SIZE_DEFAULT,
): Promise<FeedDiscoveryPage> {
  // Validate encryption configuration before starting a database aggregation;
  // production must never serve cursors using the development fallback.
  cursorSecret()
  const query = normalizeDiscoveryQuery(input)
  const finitePageSize = Number.isFinite(requestedPageSize) ? requestedPageSize : PAGE_SIZE_DEFAULT
  const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, Math.floor(finitePageSize)))
  const hash = queryFingerprint(query, pageSize)
  const parsedCursor = input.cursor ? parseCursor(input.cursor, hash, now) : undefined
  const snapshotAt = parsedCursor ? new Date(parsedCursor.a) : now
  const direction = parsedCursor && input.direction === 'before' ? 'before' as const : 'after' as const

  const pagePipeline: PipelineStage.FacetPipelineStage[] = []
  if (parsedCursor) pagePipeline.push({ $match: cursorMatch(parsedCursor, query.sort, direction) })
  pagePipeline.push(
    { $sort: databaseSort(query.sort, direction) },
    { $limit: pageSize + 1 },
  )

  const projection = {
    title: 1,
    titleTokens: 1,
    company: 1,
    companyKey: 1,
    locations: 1,
    locationKeys: 1,
    isRemote: 1,
    domain: 1,
    postedAt: 1,
    salaryText: 1,
    provenance: 1,
    flags: 1,
    confidentialCompany: 1,
  }
  const locationPreferenceMatched = query.locationKey
    ? { $in: [query.locationKey, { $ifNull: ['$locationKeys', []] }] }
    : false
  const rowPreparation: PipelineStage.FacetPipelineStage[] = [
    { $project: projection },
    {
      $set: {
        sortPostedAt: {
          $cond: [
            {
              $and: [
                { $eq: [{ $type: '$postedAt' }, 'date'] },
                { $gte: ['$postedAt', new Date(0)] },
                { $lte: ['$postedAt', snapshotAt] },
              ],
            },
            '$postedAt',
            new Date(0),
          ],
        },
        locationPreferenceMatched,
      },
    },
    {
      $set: {
        personalizationScore: query.sort === 'best'
          ? personalizationScoreExpression(query)
          : 0,
        discoveryScore: query.sort === 'best'
          ? discoveryScoreExpression(query, snapshotAt)
          : 0,
      },
    },
  ]
  const rowsPipeline: PipelineStage.FacetPipelineStage[] = query.sort === 'newest'
    ? [
        // The upstream raw postedAt sort is indexable. Limit its public
        // candidate window before computing display-safe fallback fields.
        { $limit: FEED_RESULT_CAP },
        ...rowPreparation,
        { $sort: databaseSort(query.sort, 'after') },
        ...pagePipeline,
      ]
    : [
        ...rowPreparation,
        { $sort: databaseSort(query.sort, 'after') },
        { $limit: FEED_RESULT_CAP },
        ...pagePipeline,
      ]
  const pipeline: PipelineStage[] = [
    { $match: buildBaseMatch(query, snapshotAt) },
    ...(query.sort === 'newest'
      ? [{ $sort: { postedAt: -1 as const, _id: -1 as const } }]
      : []),
    {
      $facet: {
        rows: rowsPipeline,
        metadata: [{ $count: 'total' }],
      },
    },
  ]

  const [result] = await JobPosting.aggregate<{
    rows: FeedDiscoveryRow[]
    metadata: Array<{ total: number }>
  }>(pipeline).option({ maxTimeMS: AGGREGATION_MAX_TIME_MS })
  const rawRows = result?.rows ?? []
  const hasExtra = rawRows.length > pageSize
  const selected = rawRows.slice(0, pageSize)
  const rows = direction === 'before' ? selected.reverse() : selected
  const hasPrevious = parsedCursor ? (direction === 'before' ? hasExtra : true) : false
  const hasNext = parsedCursor ? (direction === 'before' ? true : hasExtra) : hasExtra
  const total = result?.metadata?.[0]?.total ?? 0
  const emptyPageRecoveryCursor = parsedCursor && rows.length === 0 ? input.cursor : undefined

  return {
    rows,
    pageSize,
    total,
    accessibleTotal: Math.min(total, FEED_RESULT_CAP),
    resultCap: FEED_RESULT_CAP,
    capped: total > FEED_RESULT_CAP,
    hasNext,
    hasPrevious,
    nextCursor: hasNext
      ? rows.length
        ? encodeCursor(rows[rows.length - 1], hash, snapshotAt)
        : direction === 'before'
          ? emptyPageRecoveryCursor
          : undefined
      : undefined,
    previousCursor: hasPrevious
      ? rows.length
        ? encodeCursor(rows[0], hash, snapshotAt)
        : direction === 'after'
          ? emptyPageRecoveryCursor
          : undefined
      : undefined,
    sort: query.sort,
  }
}
