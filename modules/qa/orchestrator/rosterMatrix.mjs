import {
  ROSTER_DOMAINS,
  ROSTER_DEPTHS,
  SMOKE_CELLS,
  PERSONAS,
} from './rosterMatrixData.mjs'

const categoryBySlug = Object.fromEntries(ROSTER_DOMAINS.map((d) => [d.slug, d.categorySlug]))

/**
 * Same rules as app/api/interview-types/route.ts depthApplies().
 * @param {string} domainSlug
 * @param {string} depthSlug
 * @param {string} [categorySlug]
 */
export function depthApplies(domainSlug, depthSlug, categorySlug = categoryBySlug[domainSlug]) {
  const d = ROSTER_DEPTHS.find((x) => x.slug === depthSlug)
  if (!d) return false
  const domains = d.domains ?? []
  const cats = d.categories ?? []
  if (domains.length === 0 && cats.length === 0) return true
  if (domains.includes(domainSlug)) return true
  return !!categorySlug && cats.includes(categorySlug)
}

/**
 * @param {'smoke' | 'full'} mode
 */
export function listMatrixCells(mode) {
  const depthSlugs = ROSTER_DEPTHS.map((d) => d.slug)
  const cells =
    mode === 'smoke'
      ? SMOKE_CELLS.map(([domain, depth]) => ({ domain, depth }))
      : // Full mode: only the domain×depth pairs the product actually offers
        // (mirrors app/api/interview-types/route.ts depthApplies). Without this the plan
        // would send unsupported cells (e.g. mechanical/coding, pm/academics) to the APIs
        // and count them in shards/quality, producing false failures.
        ROSTER_DOMAINS.flatMap(({ slug: domain, categorySlug }) =>
          depthSlugs
            .filter((depth) => depthApplies(domain, depth, categorySlug))
            .map((depth) => ({ domain, depth })),
        )

  const runs = []
  for (const cell of cells) {
    for (const persona of PERSONAS) {
      runs.push({
        domain: cell.domain,
        depth: cell.depth,
        persona,
        runId: `${cell.domain}__${cell.depth}__${persona}`,
      })
    }
  }
  return runs
}

/**
 * @param {'smoke' | 'full'} mode
 */
export function matrixCellCount(mode) {
  return listMatrixCells(mode).length
}

/**
 * Applicable domain×depth pairs (no persona expansion).
 * @param {'smoke' | 'full'} mode
 */
export function listDomainDepthCombos(mode) {
  const cells = listMatrixCells(mode)
  const seen = new Set()
  /** @type {{ domain: string, depth: string }[]} */
  const combos = []
  for (const c of cells) {
    const key = `${c.domain}/${c.depth}`
    if (seen.has(key)) continue
    seen.add(key)
    combos.push({ domain: c.domain, depth: c.depth })
  }
  return combos
}

/**
 * Shard plan for parallel workers. Harness `limit` is cumulative upper index (slice(0, limit)).
 * @param {object} opts
 * @param {'smoke' | 'full'} opts.mode
 * @param {number} opts.shards
 */
export function planShards(opts) {
  const { mode, shards } = opts
  const total = matrixCellCount(mode)
  const n = Math.max(1, shards)
  const chunk = Math.ceil(total / n)
  /** @type {{ shard: number, offset: number, limit: number, count: number }[]} */
  const plan = []

  for (let i = 0; i < n; i++) {
    const start = i * chunk
    if (start >= total) break
    const end = Math.min((i + 1) * chunk, total)
    plan.push({
      shard: i,
      offset: start,
      limit: end,
      count: end - start,
    })
  }
  return { mode, total, shards: plan.length, plan }
}

export { ROSTER_DOMAINS, ROSTER_DEPTHS, SMOKE_CELLS, PERSONAS }
