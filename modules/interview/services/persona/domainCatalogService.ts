import { createHash } from 'crypto'
import { connectDB } from '@shared/db/connection'
import { InterviewDomain } from '@shared/db/models'
import { FALLBACK_DOMAINS } from '@shared/db/seed'
import { logger } from '@shared/logger'
import {
  INTERVIEW_INFERENCE_DOMAIN_PROMPT_MAX_ITEMS,
  JD_ROLE_INFERENCE_SCHEMA_VERSION,
  normalizeInterviewRoleSlug,
} from '@shared/interviewContract'

export type InterviewDomainCatalogFallbackReason = 'empty' | 'unavailable'

export interface ActiveInterviewDomainCatalog {
  /** Bounded subset exposed to the role-inference prompt. */
  slugs: readonly string[]
  /** The exact active CMS set, used for server-side role authorization. */
  slugSet: ReadonlySet<string>
  /** Matches `slugs`; parser output may not escape the advertised enum. */
  inferenceSlugSet: ReadonlySet<string>
  /** Code inference schema + exact active CMS slug set. */
  revision: string
  /** Only a live CMS read may authorize or persist a Practice role. */
  authoritative: boolean
  source: 'cms' | 'seed-fallback'
  fallbackReason?: InterviewDomainCatalogFallbackReason
}

function catalogFrom(
  values: readonly unknown[],
  metadata: Pick<ActiveInterviewDomainCatalog, 'authoritative' | 'source' | 'fallbackReason'>,
): ActiveInterviewDomainCatalog {
  const activeSlugs = Array.from(new Set(
    values.map(normalizeInterviewRoleSlug).filter(Boolean),
  )).sort()
  const inferenceSlugs = activeSlugs.slice(0, INTERVIEW_INFERENCE_DOMAIN_PROMPT_MAX_ITEMS)
  const hash = createHash('sha256').update(activeSlugs.join('\0')).digest('hex').slice(0, 16)
  return {
    slugs: inferenceSlugs,
    slugSet: new Set(activeSlugs),
    inferenceSlugSet: new Set(inferenceSlugs),
    revision: `jd-role-v${JD_ROLE_INFERENCE_SCHEMA_VERSION}:${hash}`,
    ...metadata,
  }
}

function fallbackCatalog(
  reason: InterviewDomainCatalogFallbackReason,
): ActiveInterviewDomainCatalog {
  return catalogFrom(FALLBACK_DOMAINS.map((domain) => domain.slug), {
    authoritative: false,
    source: 'seed-fallback',
    fallbackReason: reason,
  })
}

/**
 * Runtime taxonomy authority. A non-empty CMS catalog wins exactly, including
 * custom roles and deactivated built-ins; seed data is only an outage/empty-DB
 * fallback, matching the public /api/domains contract.
 */
export async function getActiveInterviewDomainCatalog(): Promise<ActiveInterviewDomainCatalog> {
  try {
    await connectDB()
    const rows = await InterviewDomain.find({ isActive: true })
      .select('slug')
      .lean<{ slug: string }[]>()
    if (rows.length > 0) {
      const catalog = catalogFrom(rows.map((row) => row.slug), {
        authoritative: true,
        source: 'cms',
      })
      if (catalog.slugSet.size > INTERVIEW_INFERENCE_DOMAIN_PROMPT_MAX_ITEMS) {
        logger.warn(
          {
            activeCount: catalog.slugSet.size,
            promptMax: INTERVIEW_INFERENCE_DOMAIN_PROMPT_MAX_ITEMS,
          },
          'active interview domains exceed the inference prompt cap; direct roles remain available while inference uses a deterministic subset',
        )
      }
      return catalog
    }
    logger.warn('active interview domain catalog is empty; using non-authoritative fallback')
    return fallbackCatalog('empty')
  } catch (err) {
    logger.warn(
      { err },
      'active interview domain catalog unavailable; using non-authoritative fallback',
    )
    return fallbackCatalog('unavailable')
  }
}
