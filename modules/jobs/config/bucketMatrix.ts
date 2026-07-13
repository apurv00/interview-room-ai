import { JOB_DOMAINS } from './domains'
import { METROS } from './metros'

/**
 * JSearch harvest matrix (probe-validated): domain × metro + domain × remote.
 * Under ruling #17 the buckets are HARVEST cells (coverage past the 3-page
 * cap), never verdict/filter units — scoring is domain × country, and the
 * feed ranks by user preference.
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
    for (const m of METROS) {
      buckets.push({
        id: `${d.id}:${m.toLowerCase().replace(/ /g, '-')}`,
        domain: d.id,
        query: `${d.q} in ${m}`,
      })
    }
    if (!NO_REMOTE_DOMAINS.has(d.id)) {
      buckets.push({ id: `${d.id}:remote`, domain: d.id, query: `remote ${d.q} india` })
    }
  }
  return buckets
}
