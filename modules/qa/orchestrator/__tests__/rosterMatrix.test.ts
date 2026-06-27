import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  depthApplies,
  listMatrixCells,
  listDomainDepthCombos,
  matrixCellCount,
  planShards,
  ROSTER_DOMAINS,
  ROSTER_DEPTHS,
} from '../rosterMatrix.mjs'

describe('rosterMatrix', () => {
  it('covers all 25 roster domains in full mode', () => {
    const domains = new Set(listDomainDepthCombos('full').map((c) => c.domain))
    expect(domains.size).toBe(ROSTER_DOMAINS.length)
    for (const d of ROSTER_DOMAINS) {
      expect(domains.has(d.slug), `missing domain ${d.slug}`).toBe(true)
    }
  })

  it('full matrix includes only APPLICABLE domain×depth combos (103 combos × 2 personas = 206 cells)', () => {
    // Full mode is filtered by depthApplies — it must NOT over-generate unsupported cells
    // (e.g. mechanical/coding, pm/academics) that users cannot start.
    const expectedCombos = ROSTER_DOMAINS.flatMap(({ slug, categorySlug }) =>
      ROSTER_DEPTHS.filter((d) => depthApplies(slug, d.slug, categorySlug)).map((d) => d.slug),
    )
    expect(listDomainDepthCombos('full').length).toBe(expectedCombos.length)
    expect(listDomainDepthCombos('full').length).toBe(103)
    expect(matrixCellCount('full')).toBe(206)
  })

  it('full mode pairs each domain with exactly its applicable depths (no unsupported cells)', () => {
    const combos = listDomainDepthCombos('full')
    // every emitted combo is applicable
    for (const c of combos) {
      expect(depthApplies(c.domain, c.depth), `unsupported cell ${c.domain}/${c.depth}`).toBe(true)
    }
    // and every applicable combo is emitted; inapplicable ones are absent
    for (const { slug, categorySlug } of ROSTER_DOMAINS) {
      for (const d of ROSTER_DEPTHS) {
        const present = combos.some((c) => c.domain === slug && c.depth === d.slug)
        expect(present, `${slug}/${d.slug}`).toBe(depthApplies(slug, d.slug, categorySlug))
      }
    }
    // spot-checks: these unsupported cells must NOT appear
    expect(combos.some((c) => c.domain === 'mechanical' && c.depth === 'coding')).toBe(false)
    expect(combos.some((c) => c.domain === 'pm' && c.depth === 'academics')).toBe(false)
  })

  it('smoke matrix is 9 combos × 2 personas = 18 cells (incl. 3 academics)', () => {
    expect(listDomainDepthCombos('smoke').length).toBe(9)
    expect(matrixCellCount('smoke')).toBe(18)
  })

  it('category-aware depth rules match interview-types expectations', () => {
    expect(depthApplies('fullstack', 'coding')).toBe(true)
    expect(depthApplies('fullstack', 'case-study')).toBe(false)
    expect(depthApplies('mechanical', 'behavioral')).toBe(true)
    expect(depthApplies('mechanical', 'coding')).toBe(false)
    expect(depthApplies('finance', 'case-study')).toBe(true)
    expect(depthApplies('ml-engineer', 'system-design')).toBe(true)
    // academics: programming / data-ai / core-engineering / business only (0-2 viva)
    expect(depthApplies('backend', 'academics')).toBe(true)
    expect(depthApplies('mechanical', 'academics')).toBe(true)
    expect(depthApplies('marketing', 'academics')).toBe(true)
    expect(depthApplies('data-analyst', 'academics')).toBe(true)
    expect(depthApplies('pm', 'academics')).toBe(false)
    expect(depthApplies('design', 'academics')).toBe(false)
    expect(depthApplies('general', 'academics')).toBe(false)
  })

  it('3-shard plan splits 206 cells evenly', () => {
    const { total, plan } = planShards({ mode: 'full', shards: 3 })
    expect(total).toBe(206)
    expect(plan).toHaveLength(3)
    expect(plan.reduce((n, s) => n + s.count, 0)).toBe(206)
    expect(plan[0].count).toBe(69)
    expect(plan[1].count).toBe(69)
    expect(plan[2].count).toBe(68)
  })

  it('runIds are unique across full matrix', () => {
    const runs = listMatrixCells('full')
    const ids = runs.map((r) => r.runId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('category-applicable combos align with QuestionBank backfill (80 cells)', () => {
    const backfill = JSON.parse(
      readFileSync(join(process.cwd(), 'shared/db/data/questionBankBackfill.json'), 'utf8'),
    ) as { domain: string; interviewType: string }[]
    const backfillKeys = new Set(backfill.map((q) => `${q.domain}/${q.interviewType}`))
    const applicableKeys = ROSTER_DOMAINS.flatMap(({ slug: domain, categorySlug }) =>
      ROSTER_DEPTHS.map((d) => ({ domain, depth: d.slug, categorySlug })),
    )
      .filter((c) => depthApplies(c.domain, c.depth, c.categorySlug))
      // academics draws questions from the per-domain {domain}-academics.md skill file,
      // not the QuestionBank, so it is intentionally excluded from the backfill invariant.
      .filter((c) => c.depth !== 'academics')
      .map((c) => `${c.domain}/${c.depth}`)
    const nonGeneral = applicableKeys.filter((k) => !k.startsWith('general/'))
    expect(nonGeneral.length).toBe(80)
    for (const key of nonGeneral) {
      expect(backfillKeys.has(key), `missing question bank for ${key}`).toBe(true)
    }
  })
})
