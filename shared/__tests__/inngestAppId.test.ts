import { describe, it, expect, afterEach, vi } from 'vitest'

// The app id is prod-safety-critical: it is the app identity in Inngest
// Cloud, and a sync from any environment repoints the app that shares it.
// These tests pin (1) the exact prod default and (2) that non-prod deploys
// can scope themselves away from prod via INNGEST_APP_ID.
describe('INNGEST_APP_ID resolution', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('defaults to the production app id when INNGEST_APP_ID is unset', async () => {
    vi.stubEnv('INNGEST_APP_ID', '')
    vi.resetModules()
    const { INNGEST_APP_ID, inngest } = await import('../services/inngest')

    expect(INNGEST_APP_ID).toBe('interview-prep-guru')
    expect(inngest.id).toBe('interview-prep-guru')
  })

  it('uses INNGEST_APP_ID when set, so staging registers as its own app', async () => {
    vi.stubEnv('INNGEST_APP_ID', 'interview-prep-guru-staging')
    vi.resetModules()
    const { INNGEST_APP_ID, inngest } = await import('../services/inngest')

    expect(INNGEST_APP_ID).toBe('interview-prep-guru-staging')
    expect(inngest.id).toBe('interview-prep-guru-staging')
  })
})
