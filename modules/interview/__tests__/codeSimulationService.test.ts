import { describe, it, expect, vi, beforeEach } from 'vitest'
import { simulateCodeRun } from '@interview/services/core/codeSimulationService'
import { completion } from '@shared/services/modelRouter'

vi.mock('@shared/services/modelRouter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/services/modelRouter')>()
  return { ...actual, completion: vi.fn() }
})

const mockedCompletion = vi.mocked(completion)

describe('simulateCodeRun (LLM-based Run)', () => {
  beforeEach(() => mockedCompletion.mockReset())

  it('returns simulated:true with the parsed stdout/stderr/exitCode', async () => {
    mockedCompletion.mockResolvedValue({ text: '{"stdout":"4\\n","stderr":"","exitCode":0}' } as never)
    const r = await simulateCodeRun('print(2+2)', 'python')
    expect(r.simulated).toBe(true)
    expect(r.stdout).toBe('4\n')
    expect(r.stderr).toBe('')
    expect(r.exitCode).toBe(0)
    expect(mockedCompletion).toHaveBeenCalledOnce()
  })

  it('does not call the model for empty code', async () => {
    const r = await simulateCodeRun('   ', 'java')
    expect(r.simulated).toBe(true)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toMatch(/empty|nothing/i)
    expect(mockedCompletion).not.toHaveBeenCalled()
  })

  it('surfaces a compile/runtime error reported by the model', async () => {
    mockedCompletion.mockResolvedValue({
      text: '{"stdout":"","stderr":"SyntaxError: invalid syntax","exitCode":1}',
    } as never)
    const r = await simulateCodeRun('def (', 'python')
    expect(r.stderr).toContain('SyntaxError')
    expect(r.exitCode).toBe(1)
  })

  // Note: the "completion throws → friendly fallback" path is covered by the
  // service's outer try/catch but isn't unit-tested here — vitest 4.x records any
  // error thrown through a spy and fails the test even when the SUT catches it.

  it('falls back to raw text on non-JSON but does NOT report a clean exit 0', async () => {
    // A prose reply (or truncated JSON) must not render under a green success badge.
    mockedCompletion.mockResolvedValue({ text: 'This code has a SyntaxError on line 1' } as never)
    const r = await simulateCodeRun('def (', 'python')
    expect(r.stdout).toContain('SyntaxError')
    expect(r.simulated).toBe(true)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toMatch(/could not be fully simulated|incomplete/i)
  })
})
