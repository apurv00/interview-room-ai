import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@shared/logger', () => ({
  aiLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

// Inngest client is instantiated at module-load. Stub it out.
vi.mock('@shared/services/inngest', () => ({
  inngest: {
    createFunction: (_config: unknown, handler: unknown) => ({
      id: 'email-digest-daily',
      handler,
    }),
  },
}))

// The job must not import (let alone call) the batch service while
// hard-disabled — this mock exists purely to catch a regression where
// someone re-wires it without the dedupe/frequency fixes.
const mockProcessEmailBatch = vi.fn()
vi.mock('@learn/services/emailTriggerService', () => ({
  processEmailBatch: (...args: unknown[]) => mockProcessEmailBatch(...args),
}))

import { runEmailDigestHandler } from '@learn/jobs/emailDigestJob'

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Step runner that just invokes the wrapped fn — mirrors pathwayJob.test.ts. */
function makeStep() {
  const names: string[] = []
  return {
    names,
    step: {
      run: async <T,>(name: string, fn: () => Promise<T> | T): Promise<T> => {
        names.push(name)
        return fn()
      },
    },
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('emailDigestJob — hard-disabled pending dedupe/frequency fixes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('skips the batch unconditionally and reports the skip', async () => {
    const { step, names } = makeStep()

    const result = await runEmailDigestHandler({ step })

    expect(result).toEqual({ sent: 0, errors: 0, skipped: true })
    expect(mockProcessEmailBatch).not.toHaveBeenCalled()
    expect(names).toEqual([]) // no step even scheduled — nothing for Inngest to retry
  })

  it('cannot be enabled by environment variables (founder ruling: no flip keys)', async () => {
    for (const [name, value] of [
      ['EMAIL_DIGEST_ENABLED', 'true'],
      ['ENABLE_EMAIL_DIGEST', 'true'],
      ['EMAIL_DIGEST', '1'],
    ] as const) {
      vi.stubEnv(name, value)
      const { step } = makeStep()

      const result = await runEmailDigestHandler({ step })

      expect(result).toMatchObject({ skipped: true })
      expect(mockProcessEmailBatch).not.toHaveBeenCalled()
      vi.unstubAllEnvs()
    }
  })
})
