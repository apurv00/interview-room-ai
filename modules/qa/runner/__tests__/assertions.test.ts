import { describe, it, expect } from 'vitest'
import { evaluateActivity, verdictFromAssertions, summarizeTelemetry } from '../assertions.mjs'

describe('qa assertions', () => {
  it('flags 5xx responses', () => {
    const bundle = {
      step: 'generate-question',
      stage: 'interview',
      apiResult: { ok: false, status: 503, ms: 100 },
      network: [{ method: 'POST', url: '/api/generate-question', status: 503, durationMs: 100, failed: false }],
      console: [],
      meta: { question: 'Tell me about a time when you led a project with clear metrics and outcomes.' },
    }
    const assertions = evaluateActivity(bundle)
    expect(assertions.some((a) => a.id === 'no-5xx' && !a.pass)).toBe(true)
    expect(verdictFromAssertions(assertions)).toBe('fail')
  })

  it('passes short question check when question is long enough', () => {
    const bundle = {
      step: 'generate-question',
      stage: 'interview',
      apiResult: { ok: true, status: 200, ms: 500 },
      network: [],
      console: [],
      meta: { question: 'Describe a challenging frontend project with measurable impact.' },
    }
    const assertions = evaluateActivity(bundle)
    expect(assertions.find((a) => a.id === 'q-nonempty')?.pass).toBe(true)
    expect(verdictFromAssertions(assertions)).toBe('pass')
  })

  it('summarizes telemetry by stage', () => {
    const summary = summarizeTelemetry([
      { stage: 'pathway', verdict: 'pass' },
      { stage: 'pathway', verdict: 'fail' },
      { stage: 'interview', verdict: 'warn' },
    ])
    expect(summary.total).toBe(3)
    expect(summary.fail).toBe(1)
    expect(summary.byStage.pathway.total).toBe(2)
  })
})
