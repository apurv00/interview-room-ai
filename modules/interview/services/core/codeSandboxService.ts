import { logger } from '@shared/logger'
import type { CodeLanguage } from '@shared/types'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExecutionResult {
  stdout: string
  stderr: string
  exitCode: number
  executionTimeMs: number
  timedOut: boolean
}

export interface TestCaseResult {
  input: string
  expectedOutput: string
  actualOutput: string
  passed: boolean
  executionTimeMs: number
}

// ─── Language mapping for Piston API ──────────────────────────────────────────

const PISTON_LANGUAGES: Record<CodeLanguage, { language: string; version: string }> = {
  python: { language: 'python', version: '3.10' },
  javascript: { language: 'javascript', version: '18.15' },
  typescript: { language: 'typescript', version: '5.0' },
  java: { language: 'java', version: '15.0' },
  cpp: { language: 'c++', version: '10.2' },
}

// Point this at a self-hosted Piston instance. The public emkc.org Piston API
// became whitelist-only on 2026-02-15 and now returns 401 on /execute, so the
// default below will NOT work in production — set PISTON_API_URL to your own
// Piston (e.g. `docker run -p 2000:2000 ghcr.io/engineer-man/piston`). Optionally
// set PISTON_API_KEY if your instance sits behind an auth proxy; its value is sent
// verbatim as the Authorization header (e.g. "Bearer <token>").
const PISTON_API_URL = process.env.PISTON_API_URL || 'https://emkc.org/api/v2/piston'
const PISTON_API_KEY = process.env.PISTON_API_KEY || ''
const DEFAULT_TIMEOUT_MS = 10000
const MAX_OUTPUT_LENGTH = 10000

// ─── Execute Code ─────────────────────────────────────────────────────────────

/**
 * Execute code in a sandboxed environment using the Piston API.
 * Supports Python, JavaScript, TypeScript, Java, C++.
 */
export async function executeCode(
  code: string,
  language: CodeLanguage,
  stdin: string = '',
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<ExecutionResult> {
  const langConfig = PISTON_LANGUAGES[language]
  if (!langConfig) {
    return {
      stdout: '',
      stderr: `Unsupported language: ${language}`,
      exitCode: 1,
      executionTimeMs: 0,
      timedOut: false,
    }
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs + 5000)

    const response = await fetch(`${PISTON_API_URL}/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(PISTON_API_KEY ? { Authorization: PISTON_API_KEY } : {}),
      },
      signal: controller.signal,
      body: JSON.stringify({
        language: langConfig.language,
        version: langConfig.version,
        files: [{ content: code }],
        stdin,
        run_timeout: timeoutMs,
        compile_timeout: timeoutMs,
        run_memory_limit: 256_000_000, // 256MB
      }),
    })

    clearTimeout(timeout)

    if (!response.ok) {
      const errText = await response.text()
      logger.error({ status: response.status, errText }, 'Piston API error')
      // Degrade gracefully — the candidate can still write and Submit; Run is an
      // optional convenience. 401/403 means the configured runner rejected us
      // (e.g. the public emkc Piston is now whitelist-only) → tell the candidate
      // it's a service issue, not their code.
      const friendly =
        response.status === 401 || response.status === 403
          ? 'Code execution is temporarily unavailable (sandbox not configured). You can still write your solution and click Submit.'
          : response.status === 429
            ? 'Too many runs right now — wait a few seconds and try again.'
            : `Code execution service error (${response.status}). You can still Submit your solution.`
      return {
        stdout: '',
        stderr: friendly,
        exitCode: 1,
        executionTimeMs: 0,
        timedOut: false,
      }
    }

    const data = await response.json()
    const compile = data.compile || {}
    const run = data.run || {}

    // Compiled languages (java, c++, typescript) report syntax/compile errors on
    // `compile.stderr` with a non-zero `compile.code`, and the `run` stage is then
    // empty. Surface those diagnostics so a compile failure shows the actual
    // compiler message instead of just "exit 1 / No output" (Codex P2). Interpreted
    // languages have no compile stage, so this is a no-op for them.
    const compileFailed = typeof compile.code === 'number' && compile.code !== 0
    const stderr = compileFailed
      ? compile.stderr || compile.output || 'Compilation failed'
      : run.stderr || ''
    const exitCode = compileFailed ? compile.code : run.code ?? 1

    return {
      stdout: (run.stdout || '').slice(0, MAX_OUTPUT_LENGTH),
      stderr: stderr.slice(0, MAX_OUTPUT_LENGTH),
      exitCode,
      executionTimeMs: run.wall_time ? Math.round(run.wall_time * 1000) : 0,
      timedOut: run.signal === 'SIGKILL',
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return {
        stdout: '',
        stderr: 'Execution timed out',
        exitCode: 1,
        executionTimeMs: timeoutMs,
        timedOut: true,
      }
    }
    logger.error({ err }, 'Code execution failed')
    return {
      stdout: '',
      stderr: err instanceof Error ? err.message : 'Unknown execution error',
      exitCode: 1,
      executionTimeMs: 0,
      timedOut: false,
    }
  }
}

// ─── Run Test Cases ───────────────────────────────────────────────────────────

/**
 * Run code against a set of test cases.
 * Each test case provides stdin input and expected stdout output.
 */
export async function runTestCases(
  code: string,
  language: CodeLanguage,
  testCases: Array<{ input: string; expectedOutput: string }>
): Promise<TestCaseResult[]> {
  const results: TestCaseResult[] = []

  for (const tc of testCases) {
    const execResult = await executeCode(code, language, tc.input)
    const actualOutput = execResult.stdout.trim()
    const expectedOutput = tc.expectedOutput.trim()

    results.push({
      input: tc.input,
      expectedOutput,
      actualOutput,
      passed: actualOutput === expectedOutput,
      executionTimeMs: execResult.executionTimeMs,
    })
  }

  return results
}
