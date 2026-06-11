import { describe, it, expect, vi, afterEach } from 'vitest'
import { executeCode } from '@interview/services/core/codeSandboxService'

/**
 * Codex P2 (PR #452): compiled-language failures must surface Piston's
 * `compile.stderr`, not just an empty `run` stage → "exit 1 / No output".
 */
describe('executeCode — Piston response parsing', () => {
  const realFetch = global.fetch
  afterEach(() => {
    global.fetch = realFetch
    vi.restoreAllMocks()
  })

  function mockPiston(body: unknown) {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => body,
    }) as unknown as typeof fetch
  }

  it('surfaces compile stderr for a compiled-language compile failure', async () => {
    mockPiston({
      compile: { stdout: '', stderr: "Main.java:1: error: reached end of file while parsing", code: 1 },
      run: { stdout: '', stderr: '', code: 0 },
    })
    const r = await executeCode('public class Main {', 'java')
    expect(r.stderr).toContain('error:')
    expect(r.exitCode).toBe(1)
  })

  it('uses run output when compilation succeeds', async () => {
    mockPiston({
      compile: { stdout: '', stderr: '', code: 0 },
      run: { stdout: 'hello\n', stderr: '', code: 0 },
    })
    const r = await executeCode('print("hello")', 'python')
    expect(r.stdout).toBe('hello\n')
    expect(r.stderr).toBe('')
    expect(r.exitCode).toBe(0)
  })

  it('surfaces runtime stderr when compile passes but run fails', async () => {
    mockPiston({
      compile: { code: 0 },
      run: { stdout: '', stderr: 'Exception in thread "main"', code: 1 },
    })
    const r = await executeCode('class Main {}', 'java')
    expect(r.stderr).toContain('Exception')
    expect(r.exitCode).toBe(1)
  })

  it('handles interpreted languages with no compile stage', async () => {
    mockPiston({ run: { stdout: 'ok', stderr: '', code: 0 } })
    const r = await executeCode('console.log("ok")', 'javascript')
    expect(r.stdout).toBe('ok')
    expect(r.exitCode).toBe(0)
  })
})
