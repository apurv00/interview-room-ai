import type { IJobSourceConfig, IJobIngestCursor } from '@shared/db/models'
import type { ApplyTier } from '../config/spamRules'

/**
 * Source-adapter contract (INGESTION §4.1). Adapters are the ONLY layer that
 * knows a provider's wire shapes; everything downstream (pipeline, gate,
 * identity) consumes NormalizedJob. `normalize` returning null = schema
 * drift, COUNTED per source (>20% drift → degraded, >50% → quarantined) —
 * never silently dropped.
 */

export type FetchTarget =
  | { kind: 'bucket'; bucketId: string; query: string; datePostedWindow: 'day' | '3days' | 'week'; page: number }
  | { kind: 'board'; boardId: string; slug: string; atsKind: 'greenhouse' | 'lever' | 'smartrecruiters' | 'ashby' | 'workable' | 'bamboohr' }
  | { kind: 'sitemap'; shardUrl: string; slugFilter: { metros: string[]; domainPatterns: RegExp[]; maxDetailFetches: number } }
  | { kind: 'feed'; feedId: string; page: number; perPage: number }

export interface FetchResult {
  ok: boolean
  /** HTTP status; 0 = network-level failure. */
  status: number
  /** Provider-shaped raw postings — opaque to everything but normalize(). */
  raw: unknown[]
  /** True when a 200 carried an error-shaped/unparseable envelope. */
  bodyError?: boolean
  /** Physical request count (RapidAPI bills attempts — metered, not logical calls). */
  attempts: number
}

export interface NormalizedApplyOption {
  url: string
  publisher?: string
  isDirect?: boolean
}

export interface NormalizedJob {
  title: string
  company: string
  city: string
  isRemote: boolean
  description: string
  postedAt: string | null
  validThrough: string | null
  /** Provider row id — MAY rotate per fetch on aggregators (JSearch). */
  externalId: string | null
  viaSite: string
  applyOptions: NormalizedApplyOption[]
  /** Taxonomy domain the harvest target implies (bucket domain). */
  domainHint?: string
}

export interface JobSourceAdapter {
  readonly sourceId: string
  readonly kind: IJobSourceConfig['kind']
  buildTargets(config: Pick<IJobSourceConfig, 'sourceId' | 'enabled'>, cursors: Array<Pick<IJobIngestCursor, 'bucket' | 'newestPostedAt'>>): FetchTarget[]
  fetch(target: FetchTarget): Promise<FetchResult>
  normalize(raw: unknown, target: FetchTarget): NormalizedJob | null
  classifyApplyUrl(url: string): ApplyTier
}
