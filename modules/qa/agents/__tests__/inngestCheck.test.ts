import { describe, it, expect } from 'vitest'
import {
  parseInngestIntrospection,
  evaluateInngestHealth,
  EXPECTED_FUNCTION_COUNT,
} from '../inngestCheck.mjs'

describe('inngestCheck', () => {
  it('parses function_count from serve GET response', () => {
    const parsed = parseInngestIntrospection({
      function_count: 6,
      mode: 'cloud',
      message: 'Inngest endpoint configured correctly',
    })
    expect(parsed.functionCount).toBe(6)
    expect(parsed.mode).toBe('cloud')
  })

  it('flags low function count as unhealthy', () => {
    const parsed = parseInngestIntrospection({ function_count: 4 })
    const health = evaluateInngestHealth(parsed, { expectedCount: EXPECTED_FUNCTION_COUNT })
    expect(health.ok).toBe(false)
    expect(health.severity).toBe('P0')
  })

  it('passes when count meets expected and critical ids present', () => {
    const parsed = parseInngestIntrospection({
      function_count: 6,
      functions: [
        { id: 'pathway-regenerate' },
        { id: 'multimodal-analysis' },
        { id: 'email-digest-daily' },
        { id: 'regenerate-plans-monthly' },
        { id: 'keep-mongo-warm' },
        { id: 'recording-retention-cleanup' },
      ],
    })
    const health = evaluateInngestHealth(parsed)
    expect(health.ok).toBe(true)
  })
})
