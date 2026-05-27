/** Matrix dimensions — keep in sync with qa-matrix-runner.js buildRuns(). */

const DOMAINS = ['frontend', 'backend', 'sdet', 'data-science', 'pm', 'design', 'business', 'general']
const DEPTHS = [
  { slug: 'behavioral' },
  { slug: 'technical' },
  { slug: 'case-study', domains: ['pm', 'business', 'data-science', 'design', 'general'] },
  { slug: 'system-design', domains: ['backend', 'frontend', 'data-science', 'sdet', 'general'] },
  { slug: 'coding', domains: ['backend', 'frontend', 'data-science', 'sdet'] },
]
const SMOKE_CELLS = [
  ['pm', 'behavioral'],
  ['backend', 'technical'],
  ['pm', 'case-study'],
  ['backend', 'system-design'],
  ['frontend', 'coding'],
  ['design', 'technical'],
]
const PERSONAS = ['strong', 'weak']

function applicable(domain, depth) {
  const d = DEPTHS.find((x) => x.slug === depth)
  if (!d) return false
  return !d.domains || d.domains.includes(domain)
}

/**
 * @param {'smoke' | 'full'} mode
 */
export function listMatrixCells(mode) {
  const cells =
    mode === 'smoke'
      ? SMOKE_CELLS.map(([domain, depth]) => ({ domain, depth }))
      : DOMAINS.flatMap((domain) => DEPTHS.map((d) => ({ domain, depth: d.slug }))).filter((c) =>
          applicable(c.domain, c.depth),
        )

  const runs = []
  for (const cell of cells) {
    for (const persona of PERSONAS) {
      runs.push({
        ...cell,
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
