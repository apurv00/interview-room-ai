import { JOB_DOMAINS } from './domains'

/**
 * JSearch harvest matrix: domain × COUNTRY + domain × remote.
 *
 * De-city'd 2026-07-20 (DECISIONS #23, founder cost directive). The previous
 * domain × 6-metro fan-out made 138 of ~158 daily buckets city-sliced — a
 * ~3.7× JSearch-quota multiplier layered on top of a call that is ALREADY
 * country-scoped (`country=in`, set in jsearchAdapter.fetch). #21 had removed
 * city from the PRODUCT (feed / rank / UI); this removes it from HARVEST too,
 * superseding #17's "probe queries stay city-sliced (harvest coverage)" clause.
 *
 * The coverage the metro breadth used to buy is recovered with DEPTH, not
 * breadth: a country query carries far more fresh supply per page than a single
 * metro slice did, so the §4.4 known-rate cutoff paginates it deeper (up to
 * MAX_PAGES_PER_BUCKET, raised 3→4 in the same change) instead of stopping at
 * page 1 the way a thin city slice did.
 *
 * The trailing "india" in the query text mirrors the remote cell and biases the
 * provider's ranking; `country=in` is the actual scope. metros.ts /
 * METRO_ALIASES stay untouched — `locationKey` dedup is ingestion telemetry (#21).
 *
 * Geo expansion (ruling #14) = another country's matrix file, not architecture.
 */
export interface HarvestBucket {
  id: string
  domain: string
  query: string
}

const NO_REMOTE_DOMAINS = new Set(['electrical', 'mechanical', 'civil'])

export function buildHarvestBuckets(): HarvestBucket[] {
  const buckets: HarvestBucket[] = []
  for (const d of JOB_DOMAINS) {
    // Country cell (id suffix ':in') — replaces the six per-domain metro cells.
    // domainHint downstream is bucketId.split(':')[0], so the domain survives.
    buckets.push({ id: `${d.id}:in`, domain: d.id, query: `${d.q} india` })
    if (!NO_REMOTE_DOMAINS.has(d.id)) {
      buckets.push({ id: `${d.id}:remote`, domain: d.id, query: `remote ${d.q} india` })
    }
  }
  return buckets
}
