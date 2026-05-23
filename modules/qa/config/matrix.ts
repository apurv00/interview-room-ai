import type { InterviewDepth, MatrixCell, MatrixRun, PersonaKind } from '../agent/types'

/** Self-contained domain catalog (mirrors product staticData — not imported). */
export const QA_DOMAINS = [
  'frontend',
  'backend',
  'sdet',
  'data-science',
  'pm',
  'design',
  'business',
  'general',
] as const

export const QA_DEPTHS: Array<{ slug: InterviewDepth; applicableDomains?: string[] }> = [
  { slug: 'behavioral' },
  { slug: 'technical' },
  { slug: 'case-study', applicableDomains: ['pm', 'business', 'data-science', 'design', 'general'] },
  { slug: 'system-design', applicableDomains: ['backend', 'frontend', 'data-science', 'sdet', 'general'] },
  { slug: 'coding', applicableDomains: ['backend', 'frontend', 'data-science', 'sdet'] },
]

export function isPairApplicable(domain: string, depth: InterviewDepth): boolean {
  const def = QA_DEPTHS.find((d) => d.slug === depth)
  if (!def) return false
  if (!def.applicableDomains) return true
  return def.applicableDomains.includes(domain)
}

export function buildMatrixCells(filter?: { domain?: string; depth?: InterviewDepth }): MatrixCell[] {
  const cells: MatrixCell[] = []
  for (const domain of QA_DOMAINS) {
    if (filter?.domain && filter.domain !== domain) continue
    for (const { slug } of QA_DEPTHS) {
      if (filter?.depth && filter.depth !== slug) continue
      cells.push({ domain, depth: slug, applicable: isPairApplicable(domain, slug) })
    }
  }
  return cells.filter((c) => c.applicable)
}

/** Smoke: one domain per depth family. */
export const SMOKE_CELLS: Array<{ domain: string; depth: InterviewDepth }> = [
  { domain: 'pm', depth: 'behavioral' },
  { domain: 'backend', depth: 'technical' },
  { domain: 'pm', depth: 'case-study' },
  { domain: 'backend', depth: 'system-design' },
  { domain: 'frontend', depth: 'coding' },
  { domain: 'design', depth: 'technical' },
]

export function buildRunPlan(
  mode: 'smoke' | 'full' | 'single',
  personas: PersonaKind[],
  filter?: { domain?: string; depth?: InterviewDepth },
): MatrixRun[] {
  let cells: MatrixCell[]
  if (mode === 'single') {
    cells = buildMatrixCells(filter)
    if (cells.length === 0 && filter?.domain && filter?.depth) {
      cells = [{ domain: filter.domain, depth: filter.depth, applicable: true }]
    }
  } else if (mode === 'smoke') {
    cells = SMOKE_CELLS.map((c) => ({ ...c, applicable: true }))
  } else {
    cells = buildMatrixCells()
  }

  const runs: MatrixRun[] = []
  for (const cell of cells) {
    for (const persona of personas) {
      runs.push({
        cell,
        persona,
        runId: `${cell.domain}__${cell.depth}__${persona}`,
      })
    }
  }
  return runs
}

export function matrixKey(domain: string, depth: string, persona: string): string {
  return `${domain}/${depth}/${persona}`
}
