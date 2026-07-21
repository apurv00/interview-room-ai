import { connectDB } from '@shared/db/connection'
import { JobApplication, JobPosting, JobSourceConfig } from '@shared/db/models'
import { logger } from '@shared/logger'
import {
  JOB_SOURCE_CONTROL_MAX_POSTINGS,
  JOB_SOURCE_CONTROL_WARN_POSTINGS,
} from '../config/sourceControlLimits'
import { NORMAL_ARCHIVE_CLOSED_REASONS } from './postingAccess'
import { assertDeployedRetentionTtlIndex } from './retentionIndex'

const DAY_MS = 24 * 60 * 60 * 1000
export const JOB_POSTING_AGE_OUT_MS = 14 * DAY_MS
export const JOB_POSTING_PURGE_DELAY_MS = 7 * DAY_MS
const OWNER_REPAIR_BATCH_SIZE = 500
const PURGEABLE_CLOSED_REASONS = [...NORMAL_ARCHIVE_CLOSED_REASONS]
const AGEABLE_SOURCE_KINDS = ['aggregator-api', 'sitemap-jsonld', 'public-api'] as const

export type JobsCorpusCapacityState = 'ok' | 'warning' | 'hard-stop'

export interface JobsRetentionSweepReport {
  dryRun: boolean
  at: string
  ownerPins: {
    applicationOwned: number
    contradictions: number
    repaired: number
  }
  freshness: {
    missingCanonicalFreshness: number
    backfilled: number
  }
  closures: {
    validThroughEligible: number
    validThroughClosed: number
    agedOutEligible: number
    agedOutClosed: number
  }
  tombstones: {
    eligibleToSlim: number
    slimmed: number
  }
  ttl: {
    indexReady: true
    indexName?: string
    staleNonPurgeable: number
    staleCleared: number
    normalArchivesEligible: number
    normalArchivesScheduled: number
  }
  corpus: {
    retained: number
    ownerPinned: number
    purgeScheduled: number
    restrictedTombstones: number
    warnAt: number
    hardStopAt: number
    state: JobsCorpusCapacityState
  }
}

export interface JobsRetentionSweepOptions {
  dryRun?: boolean
  now?: Date
  /** Standalone read-only commands disable schema initialization. The Inngest
   * runtime must keep the process-wide default connection mode. */
  schemaInitialization?: 'default' | 'disabled'
}

export function jobsCorpusCapacityStateOf(retained: number): JobsCorpusCapacityState {
  if (retained >= JOB_SOURCE_CONTROL_MAX_POSTINGS) return 'hard-stop'
  if (retained >= JOB_SOURCE_CONTROL_WARN_POSTINGS) return 'warning'
  return 'ok'
}

export function legacyCanonicalFreshnessExpression(now: Date): Record<string, unknown> {
  return {
    $ifNull: [
      {
        $reduce: {
          input: {
            $cond: [
              { $isArray: '$provenance' },
              '$provenance',
              [],
            ],
          },
          initialValue: null,
          in: {
            $cond: [
              { $eq: [{ $type: '$$this.lastSeenAt' }, 'date'] },
              { $max: ['$$value', '$$this.lastSeenAt'] },
              '$$value',
            ],
          },
        },
      },
      {
        $cond: [
          { $eq: [{ $type: '$createdAt' }, 'date'] },
          '$createdAt',
          now,
        ],
      },
    ],
  }
}

export function canonicalFreshnessExpression(now: Date): Record<string, unknown> {
  return {
    $cond: [
      { $eq: [{ $type: '$lastSeenAt' }, 'date'] },
      '$lastSeenAt',
      legacyCanonicalFreshnessExpression(now),
    ],
  }
}

export function validThroughExpiryFilter(now: Date): Record<string, unknown> {
  return {
    status: 'open',
    validThrough: { $lte: now },
    // A newer accepted source contribution outranks an older contributing
    // source's deadline. Without this guard, a live ATS/no-deadline refresh
    // would reopen and then be closed again every day.
    $expr: {
      $lte: [
        canonicalFreshnessExpression(now),
        '$validThrough',
      ],
    },
  }
}

/**
 * Canonical lastSeenAt is refreshed by every source contribution, including
 * rows with no externalId. Board misses can close pure ATS rows sooner; this
 * 14-day backstop closes only when the whole canonical row has gone stale.
 * validThrough expiry wins when both rules are due, keeping reports disjoint.
 */
export function agedOutPostingFilter(
  now: Date,
  ageableSourceIds: string[],
): Record<string, unknown> {
  const staleBefore = new Date(now.getTime() - JOB_POSTING_AGE_OUT_MS)
  return {
    status: 'open',
    // Pure ATS rows retain their stricter two-clean-poll evidence rule.
    // Mixed rows may use this backstop only when they carry at least one
    // explicitly configured feed/aggregator lineage.
    $and: [
      {
        $or: [
          { sourceIds: { $in: ageableSourceIds } },
          { 'provenance.sourceId': { $in: ageableSourceIds } },
        ],
      },
      {
        $or: [
          { validThrough: null },
          { validThrough: { $gt: now } },
          // Complement the immediate-expiry predicate: a contribution
          // accepted after an older deadline may stay live, but it must age
          // out once that newer canonical evidence itself becomes stale.
          {
            $expr: {
              $gt: [
                canonicalFreshnessExpression(now),
                '$validThrough',
              ],
            },
          },
        ],
      },
      {
        $or: [
          { lastSeenAt: { $lt: staleBefore } },
          {
            $expr: {
              $and: [
                { $ne: [{ $type: '$lastSeenAt' }, 'date'] },
                {
                  $lt: [
                    legacyCanonicalFreshnessExpression(now),
                    staleBefore,
                  ],
                },
              ],
            },
          },
        ],
      },
    ],
  }
}

export function tombstoneSlimmingFilter(): Record<string, unknown> {
  return {
    status: 'closed',
    closedReason: 'llm-verdict',
    $or: [
      { jdDisplayCompressed: { $exists: true } },
      { parsedJD: { $exists: true } },
      { parsedJDHash: { $exists: true } },
      { parsedJDRoleVersion: { $exists: true } },
    ],
  }
}

async function repairOwnerPins(dryRun: boolean): Promise<JobsRetentionSweepReport['ownerPins']> {
  const ownedIds = (await JobApplication.distinct('jobPostingId')).filter(Boolean)
  if (ownedIds.length === 0) {
    return { applicationOwned: 0, contradictions: 0, repaired: 0 }
  }

  const contradictionFilter = {
    _id: { $in: ownedIds },
    $or: [
      { userReferenced: { $ne: true } },
      { purgeAt: { $exists: true } },
    ],
  }
  const contradictions = await JobPosting.countDocuments(contradictionFilter)
  if (dryRun || contradictions === 0) {
    return { applicationOwned: ownedIds.length, contradictions, repaired: 0 }
  }

  let repaired = 0
  for (let index = 0; index < ownedIds.length; index += OWNER_REPAIR_BATCH_SIZE) {
    const result = await JobPosting.updateMany(
      {
        _id: { $in: ownedIds.slice(index, index + OWNER_REPAIR_BATCH_SIZE) },
        $or: contradictionFilter.$or,
      },
      { $set: { userReferenced: true }, $unset: { purgeAt: 1 } },
    )
    repaired += result.modifiedCount ?? 0
  }
  return { applicationOwned: ownedIds.length, contradictions, repaired }
}

async function closeEligiblePostings(
  filter: Record<string, unknown>,
  closedReason: 'valid-through-expired' | 'aged-out',
  now: Date,
  dryRun: boolean,
): Promise<{ eligible: number; closed: number }> {
  const eligible = await JobPosting.countDocuments(filter)
  if (dryRun || eligible === 0) return { eligible, closed: 0 }

  // Close without TTL first. A later update resolves purge eligibility from
  // the current pin and closure reason, matching the apply-link close protocol.
  const result = await JobPosting.updateMany(
    filter,
    {
      $set: { status: 'closed', closedReason, closedAt: now },
      $unset: { purgeAt: 1 },
    },
  )
  return { eligible, closed: result.modifiedCount ?? 0 }
}

async function backfillCanonicalFreshness(
  now: Date,
  dryRun: boolean,
): Promise<JobsRetentionSweepReport['freshness']> {
  const filter = {
    status: 'open',
    $expr: { $ne: [{ $type: '$lastSeenAt' }, 'date'] },
  }
  const missingCanonicalFreshness = await JobPosting.countDocuments(filter)
  if (dryRun || missingCanonicalFreshness === 0) {
    return { missingCanonicalFreshness, backfilled: 0 }
  }

  const result = await JobPosting.updateMany(filter, [
    {
      $set: {
        lastSeenAt: {
          ...legacyCanonicalFreshnessExpression(now),
        },
      },
    },
  ])
  return { missingCanonicalFreshness, backfilled: result.modifiedCount ?? 0 }
}

async function reconcilePurgeEligibility(
  now: Date,
  dryRun: boolean,
): Promise<Omit<JobsRetentionSweepReport['ttl'], 'indexReady' | 'indexName'>> {
  const purgeableNormalArchive: Record<string, unknown> = {
    status: 'closed',
    userReferenced: { $ne: true },
    closedReason: { $in: PURGEABLE_CLOSED_REASONS },
  }
  const staleFilter: Record<string, unknown> = {
    purgeAt: { $exists: true },
    $nor: [purgeableNormalArchive],
  }
  const datedTarget = {
    $dateAdd: { startDate: '$closedAt', unit: 'day', amount: 7 },
  }
  const datedEligibleFilter: Record<string, unknown> = {
    ...purgeableNormalArchive,
    closedAt: { $type: 'date' },
    $or: [
      { purgeAt: { $exists: false } },
      { $expr: { $ne: ['$purgeAt', datedTarget] } },
    ],
  }
  const undatedEligibleFilter: Record<string, unknown> = {
    ...purgeableNormalArchive,
    closedAt: { $not: { $type: 'date' } },
  }
  const [staleNonPurgeable, datedEligible, undatedEligible] = await Promise.all([
    JobPosting.countDocuments(staleFilter),
    JobPosting.countDocuments(datedEligibleFilter),
    JobPosting.countDocuments(undatedEligibleFilter),
  ])
  const normalArchivesEligible = datedEligible + undatedEligible
  if (dryRun) {
    return {
      staleNonPurgeable,
      staleCleared: 0,
      normalArchivesEligible,
      normalArchivesScheduled: 0,
    }
  }

  const staleResult = staleNonPurgeable > 0
    ? await JobPosting.updateMany(staleFilter, { $unset: { purgeAt: 1 } })
    : { modifiedCount: 0 }
  let normalArchivesScheduled = 0
  if (datedEligible > 0) {
    // Existing archives keep their original retention clock. Missing legacy
    // closedAt receives a fresh seven-day grace period instead of immediate
    // deletion. Current pin/reason predicates are evaluated atomically.
    const dated = await JobPosting.updateMany(
      datedEligibleFilter,
      [{
        $set: {
          purgeAt: datedTarget,
        },
      }],
    )
    normalArchivesScheduled += dated.modifiedCount ?? 0
  }
  if (undatedEligible > 0) {
    const undated = await JobPosting.updateMany(
      undatedEligibleFilter,
      {
        $set: {
          closedAt: now,
          purgeAt: new Date(now.getTime() + JOB_POSTING_PURGE_DELAY_MS),
        },
      },
    )
    normalArchivesScheduled += undated.modifiedCount ?? 0
  }
  return {
    staleNonPurgeable,
    staleCleared: staleResult.modifiedCount ?? 0,
    normalArchivesEligible,
    normalArchivesScheduled,
  }
}

async function slimRestrictedTombstones(
  dryRun: boolean,
): Promise<JobsRetentionSweepReport['tombstones']> {
  const filter = tombstoneSlimmingFilter()
  const eligibleToSlim = await JobPosting.countDocuments(filter)
  if (dryRun || eligibleToSlim === 0) return { eligibleToSlim, slimmed: 0 }

  // Phase 1 keeps the canonical normalized JD so URL-only/epoch re-verdicts
  // cannot evaluate an empty body. Display and parsed derivatives are never
  // served for restricted rows and can be rebuilt after a legitimate reopen.
  const result = await JobPosting.updateMany(
    filter,
    {
      $unset: {
        jdDisplayCompressed: 1,
        parsedJD: 1,
        parsedJDHash: 1,
        parsedJDRoleVersion: 1,
      },
    },
  )
  return { eligibleToSlim, slimmed: result.modifiedCount ?? 0 }
}

async function corpusReport(): Promise<JobsRetentionSweepReport['corpus']> {
  const [retained, ownerPinned, purgeScheduled, restrictedTombstones] = await Promise.all([
    JobPosting.countDocuments({}),
    JobPosting.countDocuments({ userReferenced: true }),
    JobPosting.countDocuments({
      status: 'closed',
      userReferenced: { $ne: true },
      purgeAt: { $type: 'date' },
    }),
    JobPosting.countDocuments({ status: 'closed', closedReason: 'llm-verdict' }),
  ])
  return {
    retained,
    ownerPinned,
    purgeScheduled,
    restrictedTombstones,
    warnAt: JOB_SOURCE_CONTROL_WARN_POSTINGS,
    hardStopAt: JOB_SOURCE_CONTROL_MAX_POSTINGS,
    state: jobsCorpusCapacityStateOf(retained),
  }
}

/**
 * Canonical A04 lifecycle sweep. Dry-run is physically read-only: schema
 * initialization is disabled and every mutation branch is skipped.
 */
export async function runJobsRetentionSweep(
  options: JobsRetentionSweepOptions = {},
): Promise<JobsRetentionSweepReport> {
  const dryRun = options.dryRun ?? false
  const now = options.now ?? new Date()
  const schemaInitialization = options.schemaInitialization ?? (dryRun ? 'disabled' : 'default')
  await connectDB(
    schemaInitialization === 'disabled'
      ? { schemaInitialization: 'disabled' }
      : {},
  )
  // Never claim purge scheduling is operational when the deployed database
  // lacks the absolute TTL index. This is read-only and runs before mutation.
  const ttlIndex = await assertDeployedRetentionTtlIndex()

  const ownerPins = await repairOwnerPins(dryRun)
  const freshness = await backfillCanonicalFreshness(now, dryRun)
  const validThrough = await closeEligiblePostings(
    validThroughExpiryFilter(now),
    'valid-through-expired',
    now,
    dryRun,
  )
  const ageableSources = await JobSourceConfig.find({
    kind: { $in: AGEABLE_SOURCE_KINDS },
  }).select('sourceId').lean()
  const ageableSourceIds = ageableSources.map((source) => source.sourceId)
  const agedOut = ageableSourceIds.length > 0
    ? await closeEligiblePostings(
        agedOutPostingFilter(now, ageableSourceIds),
        'aged-out',
        now,
        dryRun,
      )
    : { eligible: 0, closed: 0 }
  const tombstones = await slimRestrictedTombstones(dryRun)
  const ttlPolicy = await reconcilePurgeEligibility(now, dryRun)
  const ttl: JobsRetentionSweepReport['ttl'] = {
    indexReady: true,
    indexName: ttlIndex.matchingName,
    ...ttlPolicy,
  }
  const corpus = await corpusReport()

  const report: JobsRetentionSweepReport = {
    dryRun,
    at: now.toISOString(),
    ownerPins,
    freshness,
    closures: {
      validThroughEligible: validThrough.eligible,
      validThroughClosed: validThrough.closed,
      agedOutEligible: agedOut.eligible,
      agedOutClosed: agedOut.closed,
    },
    tombstones,
    ttl,
    corpus,
  }

  if (corpus.state === 'hard-stop') {
    logger.error({ report }, 'jobs retained corpus is at the canonical-admission hard stop')
  } else if (corpus.state === 'warning') {
    logger.warn({ report }, 'jobs retained corpus is above the warning threshold')
  } else {
    logger.info({ report }, 'jobs retention sweep complete')
  }
  return report
}
