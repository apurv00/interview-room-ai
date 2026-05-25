import { describe, it, expect } from 'vitest'
import { createRunManifest, runOutputDir } from '../runManifest.mjs'

describe('runManifest', () => {
  it('creates manifest with running status', () => {
    const m = createRunManifest({
      reportId: 'qa-browser-smoke-1',
      mode: 'smoke',
      questions: 3,
      baseUrl: 'https://www.interviewprep.guru',
      status: 'running',
    })
    expect(m.status).toBe('running')
    expect(m.reportId).toBe('qa-browser-smoke-1')
    expect(m.version).toBe(1)
  })

  it('resolves run output directory', () => {
    expect(runOutputDir('qa-browser-full-123')).toContain('output')
    expect(runOutputDir('qa-browser-full-123')).toContain('qa-browser-full-123')
  })
})
