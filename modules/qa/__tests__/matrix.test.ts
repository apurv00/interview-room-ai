import { describe, it, expect } from 'vitest'
import { buildMatrixCells, buildRunPlan, isPairApplicable } from '../config/matrix'

describe('QA matrix', () => {
  it('builds 30 applicable domain×depth pairs in full mode', () => {
    const cells = buildMatrixCells()
    expect(cells).toHaveLength(30)
    expect(cells.every((c) => c.applicable)).toBe(true)
  })

  it('excludes coding for pm', () => {
    expect(isPairApplicable('pm', 'coding')).toBe(false)
    expect(isPairApplicable('frontend', 'coding')).toBe(true)
  })

  it('full mode produces 60 runs (30 × strong/weak)', () => {
    const runs = buildRunPlan('full', ['strong', 'weak'])
    expect(runs).toHaveLength(60)
  })

  it('smoke mode produces 12 runs', () => {
    const runs = buildRunPlan('smoke', ['strong', 'weak'])
    expect(runs).toHaveLength(12)
  })

  it('single mode filters domain/depth', () => {
    const runs = buildRunPlan('single', ['strong'], { domain: 'backend', depth: 'system-design' })
    expect(runs).toHaveLength(1)
    expect(runs[0].runId).toBe('backend__system-design__strong')
  })
})
