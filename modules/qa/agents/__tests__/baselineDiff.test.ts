import { describe, it, expect } from 'vitest'
import { computeRunMetrics, computeAutoFindings } from '../runMetrics.mjs'
import { diffMetrics, DEFAULT_BASELINE_ID } from '../baselineDiff.mjs'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

describe('baselineDiff', () => {
  it('detects pathway fix vs full baseline', () => {
    const baselinePath = join(root, 'modules/qa/output/qa-browser-full-1779529900005.json')
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'))
    const baselineMetrics = computeRunMetrics(baseline)

    const currentReport = {
      reportId: 'qa-browser-smoke-test',
      mode: 'smoke',
      totalRuns: 3,
      passedRuns: 1,
      passRate: 1 / 3,
      runs: [
        { matrixKey: 'pm/behavioral/strong', pass: false, stages: { pathway: { pathwayGenerationStatus: 'succeeded' }, feedback: { pass: true }, analysis: { data: { status: 'completed' } } } },
        { matrixKey: 'pm/behavioral/weak', pass: true, stages: { pathway: { pathwayGenerationStatus: 'succeeded' }, feedback: { pass: true }, analysis: { data: { status: 'completed' } } } },
        { matrixKey: 'backend/technical/strong', pass: false, stages: { pathway: { pathwayGenerationStatus: 'succeeded' }, feedback: { pass: true }, analysis: { data: { status: 'completed' } } } },
      ],
      evaluationRows: [],
    }
    const currentMetrics = computeRunMetrics(currentReport)
    const diff = diffMetrics(baselineMetrics, currentMetrics)

    expect(baselineMetrics.pathwayGenSucceeded).toBe(0)
    expect(currentMetrics.pathwayGenSucceeded).toBe(3)
    expect(diff.pathwayFixed).toBe(true)
    expect(DEFAULT_BASELINE_ID).toBe('qa-browser-full-1779529900005')
  })
})

describe('triage auto findings', () => {
  it('does not emit AUTO-PWY-001 when pathway succeeded', () => {
    const report = {
      totalRuns: 3,
      passedRuns: 1,
      runs: Array.from({ length: 3 }, () => ({
        matrixKey: 'pm/behavioral/weak',
        pass: true,
        stages: {
          pathway: { pathwayGenerationStatus: 'succeeded', data: { state: 'active' } },
          feedback: { pass: true },
          analysis: { data: { status: 'completed' } },
        },
      })),
      evaluationRows: [],
    }
    const metrics = computeRunMetrics(report)
    const auto = computeAutoFindings(metrics, report)
    expect(auto.find((f) => f.id === 'AUTO-PWY-001')).toBeUndefined()
  })
})
