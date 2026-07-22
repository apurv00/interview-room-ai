import { createHash } from 'crypto'
import { APPLY_TIERS, TIER_RANK, type ApplyTier } from '../config/spamRules'
import { isBlockedApplyUrl } from './qualityGate'
import {
  applyLinkGenerationOf,
  applyLinkSubjectOf,
  canonicalApplyUrl,
  groupApplyLinkSubjects,
  linkDispositionOf,
  type ApplyLinkGovernance,
} from './linkGovernance'

/**
 * Public apply-option identity. The id contains no source URL or provider key;
 * it changes when the canonical URL generation changes, while presentation
 * changes such as tier/provider remain stable. Mutations resolve it against
 * the posting again, so possession of an old id is never authority.
 */
const APPLY_OPTION_ID_PREFIX = 'ao2_'
const APPLY_OPTION_ID_RE = /^ao2_[A-Za-z0-9_-]{43}$/

export interface ApplyOptionSource {
  sourceKey?: unknown
  applyUrl?: unknown
  applyUrlFirstSeenAt?: unknown
  applyTier?: unknown
  viaSite?: unknown
  firstSeenAt?: unknown
  linkGovernance?: unknown
  /** Readable for legacy rows, but never current demotion authority. */
  brokenReportCount?: unknown
}

export interface CanonicalApplyOption {
  optionId: string
  sourceKey: string
  sourceKeys: string[]
  /** Canonical public URL. */
  url: string
  /** Exact stored value used only by transactional authority filters. */
  storedUrl: string
  sourceApplyUrlFirstSeenAt?: Date
  tier: ApplyTier
  viaSite?: string
  subject: string
  generation: string
  incidentVersion: number
  governance: ApplyLinkGovernance
  broken: boolean
}

function isApplyTier(value: unknown): value is ApplyTier {
  return typeof value === 'string' && (APPLY_TIERS as readonly string[]).includes(value)
}

export function applyOptionIdOf(input: {
  sourceKey?: string
  url: string
  tier?: ApplyTier
  generation?: string
}): string {
  const canonicalUrl = canonicalApplyUrl(input.url) ?? input.url
  const subject = applyLinkSubjectOf(canonicalUrl)
  const generation = input.generation ?? applyLinkGenerationOf(subject, [])
  const digest = createHash('sha256')
    .update('jobs.apply-option.v2\0')
    .update(JSON.stringify([subject, generation]))
    .digest('base64url')
  return `${APPLY_OPTION_ID_PREFIX}${digest}`
}

export function isApplyOptionId(value: unknown): value is string {
  return typeof value === 'string' && APPLY_OPTION_ID_RE.test(value)
}

/** Strict mutation payload: no legacy URL/tier fields and no unknown keys. */
export function parseApplyOptionMutation(value: unknown): { optionId: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 1 || !isApplyOptionId(record.optionId)) return null
  return { optionId: record.optionId }
}

/** Canonical, currently usable options derived solely from posting provenance. */
export function canonicalApplyOptionsOf(
  provenance: readonly ApplyOptionSource[] | null | undefined,
): CanonicalApplyOption[] {
  const eligible = (provenance ?? []).filter((entry) => {
    const canonicalUrl = canonicalApplyUrl(entry.applyUrl)
    return typeof entry.sourceKey === 'string' && !!entry.sourceKey &&
      !!canonicalUrl && !isBlockedApplyUrl(canonicalUrl) && isApplyTier(entry.applyTier)
  })
  return groupApplyLinkSubjects(eligible).map((group) => {
    const entries = group.entries as ApplyOptionSource[]
    const representative = [...entries].sort((left, right) => {
      const tierDiff = TIER_RANK[left.applyTier as ApplyTier] - TIER_RANK[right.applyTier as ApplyTier]
      if (tierDiff !== 0) return tierDiff
      return String(left.sourceKey).localeCompare(String(right.sourceKey))
    })[0]
    const sourceApplyUrlFirstSeenAt = representative.applyUrlFirstSeenAt instanceof Date
      ? representative.applyUrlFirstSeenAt
      : typeof representative.applyUrlFirstSeenAt === 'string' ||
          typeof representative.applyUrlFirstSeenAt === 'number'
        ? new Date(representative.applyUrlFirstSeenAt)
        : undefined
    return {
      optionId: applyOptionIdOf({
        url: group.canonicalUrl,
        generation: group.generation,
      }),
      sourceKey: representative.sourceKey as string,
      sourceKeys: Array.from(new Set(entries.map((entry) => entry.sourceKey as string))),
      url: group.canonicalUrl,
      storedUrl: representative.applyUrl as string,
      sourceApplyUrlFirstSeenAt:
        sourceApplyUrlFirstSeenAt && Number.isFinite(sourceApplyUrlFirstSeenAt.getTime())
          ? sourceApplyUrlFirstSeenAt
          : undefined,
      tier: representative.applyTier as ApplyTier,
      viaSite: typeof representative.viaSite === 'string' && representative.viaSite
        ? representative.viaSite
        : undefined,
      subject: group.subject,
      generation: group.generation,
      incidentVersion: group.governance.incidentVersion,
      governance: group.governance,
      broken: linkDispositionOf(group.governance) !== 'pending-verification',
    }
  })
}

export function resolveApplyOption(
  provenance: readonly ApplyOptionSource[] | null | undefined,
  optionId: string,
): CanonicalApplyOption | null {
  if (!isApplyOptionId(optionId)) return null
  return canonicalApplyOptionsOf(provenance).find((option) => option.optionId === optionId) ?? null
}
