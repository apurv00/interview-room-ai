import { describe, it, expect } from 'vitest'
import {
  buildMatrixReport,
  formatMarkdownReport,
  collectEvaluationRows,
  buildRouteLatencyStats,
  formatEvaluationsCsv,
} from '../report/reportBuilder'
import type { SimulationRunResult } from '../agent/types'

describe('QA report builder', () => {
  it('aggregates route frequency and phase summary', () => {
    const run: SimulationRunResult = {
      runId: 'pm__behavioral__weak',
      matrixKey: 'pm/behavioral/weak',
      domain: 'pm',
      depth: 'behavioral',
      persona: 'weak',
      sessionId: 'abc123',
      pass: false,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 1000,
      stages: [
        {
          stage: 'interview',
          pass: false,
          startedAt: '',
          finishedAt: '',
          durationMs: 500,
          routes: [
            {
              phase: 'interview',
              method: 'POST',
              route: '/api/evaluate-answer',
              status: 200,
              durationMs: 100,
              ok: true,
              questionIndex: 0,
            },
          ],
          checks: [{ id: 'x', label: 'Score band miss', pass: false, severity: 'warn' }],
          questions: [
            {
              questionIndex: 0,
              question: 'Tell me about a product launch.',
              answer: 'vague',
              persona: 'weak',
              evaluation: { relevance: 70, structure: 70, specificity: 70, ownership: 70 },
              routes: [],
              checks: [],
              pass: true,
            },
          ],
        },
      ],
      allRoutes: [
        {
          phase: 'interview',
          method: 'POST',
          route: '/api/evaluate-answer',
          status: 200,
          durationMs: 100,
          ok: true,
        },
      ],
      upgradeRecommendations: ['[Q1] Score band miss'],
    }

    const report = buildMatrixReport({
      reportId: 'test-report',
      mode: 'smoke',
      baseUrl: 'http://localhost:3000',
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      runs: [run],
    })

    expect(report.totalRuns).toBe(1)
    expect(report.routeFrequency['POST /api/evaluate-answer']).toBe(1)
    expect(report.phaseSummary.length).toBeGreaterThan(0)
    expect(report.evaluationRows.length).toBe(1)
    expect(report.evaluationRows[0].avgDimensions).toBe(70)
    expect(report.routeLatency.length).toBeGreaterThan(0)
    const md = formatMarkdownReport(report)
    expect(md).toContain('Per-question evaluation')
    expect(md).toContain('All per-question evaluations')
    expect(md).toContain('Route latency')
    expect(md).toContain('/api/evaluate-answer')
    const csv = formatEvaluationsCsv(collectEvaluationRows([run]))
    expect(csv).toContain('pm/behavioral/weak')
    expect(csv.split('\n').length).toBe(2)
  })

  it('buildRouteLatencyStats computes percentiles', () => {
    const stats = buildRouteLatencyStats([
      {
        runId: 'x',
        matrixKey: 'x',
        domain: 'pm',
        depth: 'behavioral',
        persona: 'weak',
        pass: true,
        startedAt: '',
        finishedAt: '',
        durationMs: 0,
        stages: [],
        allRoutes: [
          { phase: 'interview', method: 'POST', route: '/api/evaluate-answer', status: 200, durationMs: 100, ok: true },
          { phase: 'interview', method: 'POST', route: '/api/evaluate-answer', status: 200, durationMs: 500, ok: true },
        ],
        upgradeRecommendations: [],
      },
    ])
    expect(stats[0].count).toBe(2)
    expect(stats[0].maxMs).toBe(500)
  })
})
