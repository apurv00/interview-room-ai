import { createHash } from 'node:crypto'
import type { PipelineStage } from 'mongoose'
import { JobIngestCycle, JobPosting } from '@shared/db/models'
import { JOB_DOMAIN_IDS } from '../config/domains'
import { APPLY_TIERS } from '../config/spamRules'
import {
  canonicalApplyOptionsOf,
  type ApplyOptionSource,
} from './applyOptionIdentity'

const DAY_MS = 24 * 60 * 60 * 1_000
const WINDOW_DAYS = 7
const MIN_USABLE_JD_LENGTH = 400
const QUERY_MAX_TIME_MS = 30_000
const JSEARCH_SOURCE_ID = 'jsearch'
const UNCLASSIFIED_DOMAIN = 'unclassified'
const UNATTRIBUTED_SOURCE = 'unattributed'

export const REMOTE_MANUAL_LABELS = ['remote-correct', 'not-remote', 'unclear'] as const
export type RemoteManualLabel = (typeof REMOTE_MANUAL_LABELS)[number]

export interface DiscoveryQualityPostingRow {
  _id: unknown
  title: string
  company: string
  companyKey?: string | null
  confidentialCompany?: boolean
  locations?: string[]
  isRemote?: boolean
  domain?: string | null
  postedAt?: Date | string | null
  createdAt: Date | string
  sourceIds?: string[]
}

export interface DiscoveryQualityCandidateRow extends DiscoveryQualityPostingRow {
  /** Query-only authority input. It is stripped before report construction. */
  provenance?: ApplyOptionSource[]
}

export interface JsearchQuotaObservation {
  quotaSpent: number
  cycleCount: number
  cyclesWithQuota: number
}

interface FreshnessMetrics {
  totalCount: number
  knownCount: number
  knownRate: number | null
  medianAgeDays: number | null
  p90AgeDays: number | null
  within7DaysCount: number
  within7DaysRateOfKnown: number | null
}

interface EmployerConcentrationMetrics {
  denominatorKnownEmployerCount: number
  excludedUnknownOrConfidentialCount: number
  top1Count: number
  top1ShareOfKnownEmployers: number | null
  top5Count: number
  top5ShareOfKnownEmployers: number | null
  topEmployers: Array<{ companyKey: string; company: string; count: number }>
}

export interface DiscoveryPopulationMetrics {
  supply: number
  freshness: FreshnessMetrics
  employerConcentration: EmployerConcentrationMetrics
}

export interface DiscoveryQualityReport {
  schemaVersion: 1
  generatedAt: string
  window: {
    days: 7
    startInclusive: string
    endExclusive: string
  }
  populationDefinition: {
    canonicalCreatedInWindow: true
    currentStatus: 'open'
    minimumNormalizedJdLength: 400
    requiresStoredApplyPath: true
    note: string
  }
  overall: DiscoveryPopulationMetrics
  byDomain: Array<{ domain: string } & DiscoveryPopulationMetrics>
  jsearchQuotaEfficiency: {
    sourceId: 'jsearch'
    quotaSpent: number
    syncCycleCount: number
    syncCyclesWithQuota: number
    quotaTelemetryComplete: boolean
    usableJobsWithJsearchLineage: number
    quotaSpentPerUsableJob: number | null
    measurementStatus: 'measured' | 'lower-bound' | 'unavailable-no-cycles' | 'unavailable-no-usable-jobs'
    denominatorDefinition: string
    interpretationCaveat: string
    perDomainAttribution: {
      available: false
      reason: string
    }
  }
  remoteManualAudit: {
    status: 'manual-labels-required'
    requestedPerSource: number
    uniqueRemoteCandidates: number
    allowedLabels: readonly RemoteManualLabel[]
    methodology: string
    precisionStatement: string
    strata: Array<{ sourceId: string; candidateCount: number; selectedCount: number }>
    rows: Array<{
      sampleId: string
      sourceId: string
      postingId: string
      title: string
      company: string
      locations: string[]
      postedAt: string | null
      manualLabel: RemoteManualLabel | null
      manualNotes: string | null
    }>
  }
  outputSafety: {
    readOnly: true
    excludes: readonly ['job-description bodies', 'apply URLs']
  }
}

interface QuotaAggregateRow {
  quotaSpent: number
  cycleCount: number
  cyclesWithQuota: number
}

function round(value: number, digits = 4): number {
  const scale = 10 ** digits
  return Math.round((value + Number.EPSILON) * scale) / scale
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? round(numerator / denominator) : null
}

function dateAtOrBefore(value: unknown, now: Date): Date | null {
  if (!(value instanceof Date) && typeof value !== 'string') return null
  const parsed = value instanceof Date ? value : new Date(value)
  const timestamp = parsed.getTime()
  if (!Number.isFinite(timestamp) || timestamp > now.getTime()) return null
  return parsed
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const value = sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
  return round(value, 3)
}

/** Nearest-rank percentile: deterministic for the p90 operational tail. */
function nearestRank(values: number[], percentile: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1)
  return round(sorted[index], 3)
}

function freshnessOf(rows: readonly DiscoveryQualityPostingRow[], now: Date): FreshnessMetrics {
  const ages = rows.flatMap((row) => {
    const postedAt = dateAtOrBefore(row.postedAt, now)
    return postedAt ? [(now.getTime() - postedAt.getTime()) / DAY_MS] : []
  })
  const within7DaysCount = ages.filter((age) => age <= WINDOW_DAYS).length
  return {
    totalCount: rows.length,
    knownCount: ages.length,
    knownRate: ratio(ages.length, rows.length),
    medianAgeDays: median(ages),
    p90AgeDays: nearestRank(ages, 0.9),
    within7DaysCount,
    within7DaysRateOfKnown: ratio(within7DaysCount, ages.length),
  }
}

function employerConcentrationOf(
  rows: readonly DiscoveryQualityPostingRow[],
): EmployerConcentrationMetrics {
  const companies = new Map<string, { names: Set<string>; count: number }>()
  let excluded = 0
  for (const row of rows) {
    const companyKey = row.companyKey?.trim()
    if (row.confidentialCompany || !companyKey) {
      excluded++
      continue
    }
    const current = companies.get(companyKey) ?? { names: new Set<string>(), count: 0 }
    const displayName = row.company?.trim()
    if (displayName) current.names.add(displayName)
    current.count++
    companies.set(companyKey, current)
  }
  const ranked = Array.from(companies, ([companyKey, value]) => ({
    companyKey,
    company: Array.from(value.names).sort((left, right) => left.localeCompare(right))[0] ?? companyKey,
    count: value.count,
  })).sort((left, right) => right.count - left.count || left.companyKey.localeCompare(right.companyKey))
  const denominator = rows.length - excluded
  const top1Count = ranked[0]?.count ?? 0
  const top5Count = ranked.slice(0, 5).reduce((sum, employer) => sum + employer.count, 0)
  return {
    denominatorKnownEmployerCount: denominator,
    excludedUnknownOrConfidentialCount: excluded,
    top1Count,
    top1ShareOfKnownEmployers: ratio(top1Count, denominator),
    top5Count,
    top5ShareOfKnownEmployers: ratio(top5Count, denominator),
    topEmployers: ranked.slice(0, 5),
  }
}

function populationMetricsOf(
  rows: readonly DiscoveryQualityPostingRow[],
  now: Date,
): DiscoveryPopulationMetrics {
  return {
    supply: rows.length,
    freshness: freshnessOf(rows, now),
    employerConcentration: employerConcentrationOf(rows),
  }
}

function domainOf(row: DiscoveryQualityPostingRow): string {
  return row.domain?.trim() || UNCLASSIFIED_DOMAIN
}

function sourceIdsOf(row: DiscoveryQualityPostingRow): string[] {
  const sourceIds = (row.sourceIds ?? [])
    .filter((sourceId): sourceId is string => typeof sourceId === 'string' && !!sourceId.trim())
    .map((sourceId) => sourceId.trim())
  const unique = Array.from(new Set(sourceIds)).sort((left, right) => left.localeCompare(right))
  return unique.length ? unique : [UNATTRIBUTED_SOURCE]
}

function postingIdOf(row: DiscoveryQualityPostingRow): string {
  return String(row._id)
}

function remoteManualAuditOf(
  rows: readonly DiscoveryQualityPostingRow[],
  now: Date,
  requestedPerSource: number,
): DiscoveryQualityReport['remoteManualAudit'] {
  const remote = rows.filter((row) => row.isRemote === true)
  const candidates = new Map<string, DiscoveryQualityPostingRow[]>()
  for (const row of remote) {
    // Canonical lineage may be multi-source. Such a row is eligible in each
    // source stratum and may therefore appear more than once in the audit queue.
    for (const sourceId of sourceIdsOf(row)) {
      const sourceRows = candidates.get(sourceId) ?? []
      sourceRows.push(row)
      candidates.set(sourceId, sourceRows)
    }
  }

  const rowsOut: DiscoveryQualityReport['remoteManualAudit']['rows'] = []
  const strata = Array.from(candidates.keys())
    .sort((left, right) => left.localeCompare(right))
    .map((sourceId) => {
      const sourceRows = candidates.get(sourceId) ?? []
      const ranked = sourceRows
        .map((row) => ({
          row,
          digest: createHash('sha256')
            .update(`jobs-remote-manual-audit:v1\0${sourceId}\0${postingIdOf(row)}`)
            .digest('hex'),
        }))
        .sort((left, right) => left.digest.localeCompare(right.digest))
      const selected = ranked.slice(0, requestedPerSource)
      for (const candidate of selected) {
        const postedAt = dateAtOrBefore(candidate.row.postedAt, now)
        rowsOut.push({
          sampleId: `remote_${candidate.digest.slice(0, 20)}`,
          sourceId,
          postingId: postingIdOf(candidate.row),
          title: candidate.row.title,
          company: candidate.row.company,
          locations: [...(candidate.row.locations ?? [])],
          postedAt: postedAt?.toISOString() ?? null,
          manualLabel: null,
          manualNotes: null,
        })
      }
      return { sourceId, candidateCount: sourceRows.length, selectedCount: selected.length }
    })

  return {
    status: 'manual-labels-required',
    requestedPerSource,
    uniqueRemoteCandidates: remote.length,
    allowedLabels: REMOTE_MANUAL_LABELS,
    methodology: 'Stable SHA-256 ordering of the 7-day remote-flagged population within each durable source lineage. Multi-source canonical rows may appear in multiple strata.',
    precisionStatement: 'No remote precision is calculated automatically. A reviewer must label every sampled row before any precision estimate is made.',
    strata,
    rows: rowsOut,
  }
}

export function discoveryQualityPostingPipeline(start: Date, end: Date): PipelineStage[] {
  return [
    {
      $match: {
        status: 'open',
        createdAt: { $gte: start, $lt: end },
        jdLength: { $gte: MIN_USABLE_JD_LENGTH },
        provenance: {
          $elemMatch: {
            sourceKey: { $type: 'string', $ne: '' },
            applyUrl: { $type: 'string', $ne: '' },
            applyTier: { $in: [...APPLY_TIERS] },
          },
        },
      },
    },
    {
      // Only the apply-authority fields needed to evaluate production's
      // canonical option predicate enter process memory. They are stripped
      // before report construction; every JD field remains excluded.
      $project: {
        _id: 1,
        title: 1,
        company: 1,
        companyKey: 1,
        confidentialCompany: 1,
        locations: 1,
        isRemote: 1,
        domain: 1,
        postedAt: 1,
        createdAt: 1,
        sourceIds: 1,
        provenance: {
          $map: {
            input: { $ifNull: ['$provenance', []] },
            as: 'entry',
            in: {
              sourceKey: '$$entry.sourceKey',
              applyUrl: '$$entry.applyUrl',
              applyUrlFirstSeenAt: '$$entry.applyUrlFirstSeenAt',
              applyTier: '$$entry.applyTier',
              viaSite: '$$entry.viaSite',
              linkGovernance: '$$entry.linkGovernance',
            },
          },
        },
      },
    },
    { $sort: { _id: 1 } },
  ]
}

/** Apply production's canonical safe/non-blocklisted/tiered option authority,
 * then copy only report-safe metadata into the measurement population. */
export function canonicalUsablePostingRows(
  candidates: readonly DiscoveryQualityCandidateRow[],
): DiscoveryQualityPostingRow[] {
  return candidates.flatMap((candidate) => {
    if (canonicalApplyOptionsOf(candidate.provenance).length === 0) return []
    return [{
      _id: candidate._id,
      title: candidate.title,
      company: candidate.company,
      companyKey: candidate.companyKey,
      confidentialCompany: candidate.confidentialCompany,
      locations: [...(candidate.locations ?? [])],
      isRemote: candidate.isRemote,
      domain: candidate.domain,
      postedAt: candidate.postedAt,
      createdAt: candidate.createdAt,
      sourceIds: [...(candidate.sourceIds ?? [])],
    }]
  })
}

export function jsearchQuotaPipeline(start: Date, end: Date): PipelineStage[] {
  const hasUsableQuota = {
    $and: [
      { $isNumber: '$quotaSpent' },
      { $gte: ['$quotaSpent', 0] },
    ],
  }
  return [
    {
      $match: {
        kind: 'sync',
        sourceId: JSEARCH_SOURCE_ID,
        startedAt: { $gte: start, $lt: end },
      },
    },
    {
      $group: {
        _id: null,
        quotaSpent: { $sum: { $cond: [hasUsableQuota, '$quotaSpent', 0] } },
        cycleCount: { $sum: 1 },
        cyclesWithQuota: { $sum: { $cond: [hasUsableQuota, 1, 0] } },
      },
    },
    { $project: { _id: 0, quotaSpent: 1, cycleCount: 1, cyclesWithQuota: 1 } },
  ]
}

export function buildDiscoveryQualityReport(
  postings: readonly DiscoveryQualityPostingRow[],
  quota: JsearchQuotaObservation,
  now = new Date(),
  options: { samplePerSource?: number; configuredDomains?: readonly string[] } = {},
): DiscoveryQualityReport {
  if (!Number.isFinite(now.getTime())) throw new Error('Discovery-quality report time must be valid')
  const start = new Date(now.getTime() - WINDOW_DAYS * DAY_MS)
  const requested = Number.isFinite(options.samplePerSource)
    ? Math.floor(options.samplePerSource as number)
    : 5
  const samplePerSource = Math.max(1, Math.min(50, requested))
  const configuredDomains = options.configuredDomains ?? JOB_DOMAIN_IDS
  const observedDomains = postings.map(domainOf)
  const domains = Array.from(new Set([...configuredDomains, ...observedDomains]))
  const byDomain = domains.map((domain) => ({
    domain,
    ...populationMetricsOf(postings.filter((row) => domainOf(row) === domain), now),
  }))

  const jsearchUsableJobs = postings.filter((row) => sourceIdsOf(row).includes(JSEARCH_SOURCE_ID)).length
  const quotaSpent = Number.isFinite(quota.quotaSpent) && quota.quotaSpent >= 0 ? quota.quotaSpent : 0
  const cycleCount = Number.isSafeInteger(quota.cycleCount) && quota.cycleCount >= 0 ? quota.cycleCount : 0
  const cyclesWithQuota = Number.isSafeInteger(quota.cyclesWithQuota) && quota.cyclesWithQuota >= 0
    ? Math.min(quota.cyclesWithQuota, cycleCount)
    : 0
  const quotaTelemetryComplete = cycleCount > 0 && cyclesWithQuota === cycleCount
  const quotaSpentPerUsableJob = cycleCount > 0 && jsearchUsableJobs > 0
    ? round(quotaSpent / jsearchUsableJobs)
    : null
  const measurementStatus = cycleCount === 0
    ? 'unavailable-no-cycles' as const
    : jsearchUsableJobs === 0
      ? 'unavailable-no-usable-jobs' as const
      : quotaTelemetryComplete
        ? 'measured' as const
        : 'lower-bound' as const

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    window: {
      days: WINDOW_DAYS,
      startInclusive: start.toISOString(),
      endExclusive: now.toISOString(),
    },
    populationDefinition: {
      canonicalCreatedInWindow: true,
      currentStatus: 'open',
      minimumNormalizedJdLength: MIN_USABLE_JD_LENGTH,
      requiresStoredApplyPath: true,
      note: 'Usable means a currently open canonical posting with normalized JD length >=400 and at least one stored non-empty apply path. The report does not re-fetch or revalidate links.',
    },
    overall: populationMetricsOf(postings, now),
    byDomain,
    jsearchQuotaEfficiency: {
      sourceId: JSEARCH_SOURCE_ID,
      quotaSpent,
      syncCycleCount: cycleCount,
      syncCyclesWithQuota: cyclesWithQuota,
      quotaTelemetryComplete,
      usableJobsWithJsearchLineage: jsearchUsableJobs,
      quotaSpentPerUsableJob,
      measurementStatus,
      denominatorDefinition: 'Current 7-day new canonical open usable postings whose durable sourceIds include jsearch; each canonical posting is counted once.',
      interpretationCaveat: 'This is an observational retained-supply ratio: source merges and postings that closed inside the window prevent causal request-to-job attribution.',
      perDomainAttribution: {
        available: false,
        reason: 'JobIngestCycle records JSearch quotaSpent only at source-sync level and does not retain domain or fetch-bucket attribution.',
      },
    },
    remoteManualAudit: remoteManualAuditOf(postings, now, samplePerSource),
    outputSafety: {
      readOnly: true,
      excludes: ['job-description bodies', 'apply URLs'],
    },
  }
}

export async function readDiscoveryQualityReport(
  now = new Date(),
  options: { samplePerSource?: number } = {},
): Promise<DiscoveryQualityReport> {
  if (!Number.isFinite(now.getTime())) throw new Error('Discovery-quality report time must be valid')
  const start = new Date(now.getTime() - WINDOW_DAYS * DAY_MS)
  const [candidates, quotaRows] = await Promise.all([
    JobPosting.aggregate<DiscoveryQualityCandidateRow>(
      discoveryQualityPostingPipeline(start, now),
    ).option({ maxTimeMS: QUERY_MAX_TIME_MS }),
    JobIngestCycle.aggregate<QuotaAggregateRow>(
      jsearchQuotaPipeline(start, now),
    ).option({ maxTimeMS: QUERY_MAX_TIME_MS }),
  ])
  const quota = quotaRows[0] ?? { quotaSpent: 0, cycleCount: 0, cyclesWithQuota: 0 }
  return buildDiscoveryQualityReport(canonicalUsablePostingRows(candidates), quota, now, options)
}
