import { createHash } from 'crypto'
import { APPLY_TIERS, type ApplyTier } from '../config/spamRules'
import { isBlockedApplyUrl } from './qualityGate'
import { canonicalizeCheckableLink } from './safeLinkNetwork'

/**
 * Public apply-option identity. The id deliberately contains no source URL or
 * provider key, but changes whenever any server-authoritative part of the
 * option changes. Mutations resolve it against the posting again; possession
 * of an old id is never authority for a replaced option.
 */
const APPLY_OPTION_ID_PREFIX = 'ao1_'
const APPLY_OPTION_ID_RE = /^ao1_[A-Za-z0-9_-]{43}$/

export interface ApplyOptionSource {
  sourceKey?: unknown
  applyUrl?: unknown
  applyTier?: unknown
  viaSite?: unknown
  brokenReportCount?: unknown
}

export interface CanonicalApplyOption {
  optionId: string
  sourceKey: string
  url: string
  tier: ApplyTier
  viaSite?: string
  broken: boolean
}

function isSafeHttpUrl(value: string): boolean {
  return canonicalizeCheckableLink(value) !== null
}

function isApplyTier(value: unknown): value is ApplyTier {
  return typeof value === 'string' && (APPLY_TIERS as readonly string[]).includes(value)
}

export function applyOptionIdOf(input: {
  sourceKey: string
  url: string
  tier: ApplyTier
}): string {
  const digest = createHash('sha256')
    .update('jobs.apply-option.v1\0')
    .update(JSON.stringify([input.sourceKey, input.url, input.tier]))
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
  const options: CanonicalApplyOption[] = []
  const seen = new Set<string>()
  for (const entry of provenance ?? []) {
    if (
      typeof entry.sourceKey !== 'string' || !entry.sourceKey ||
      typeof entry.applyUrl !== 'string' || !isSafeHttpUrl(entry.applyUrl) ||
      isBlockedApplyUrl(entry.applyUrl) ||
      !isApplyTier(entry.applyTier)
    ) continue
    const optionId = applyOptionIdOf({
      sourceKey: entry.sourceKey,
      url: entry.applyUrl,
      tier: entry.applyTier,
    })
    if (seen.has(optionId)) continue
    seen.add(optionId)
    options.push({
      optionId,
      sourceKey: entry.sourceKey,
      url: entry.applyUrl,
      tier: entry.applyTier,
      viaSite: typeof entry.viaSite === 'string' && entry.viaSite
        ? entry.viaSite
        : undefined,
      broken: typeof entry.brokenReportCount === 'number' && entry.brokenReportCount > 0,
    })
  }
  return options
}

export function resolveApplyOption(
  provenance: readonly ApplyOptionSource[] | null | undefined,
  optionId: string,
): CanonicalApplyOption | null {
  if (!isApplyOptionId(optionId)) return null
  return canonicalApplyOptionsOf(provenance).find((option) => option.optionId === optionId) ?? null
}
