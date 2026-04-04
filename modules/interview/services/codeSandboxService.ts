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

const PISTON_API_URL = process.env.PISTON_API_URL || 'https://emkc.org/api/v2/piston'
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
      headers: { 'Content-Type': 'application/json' },
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
      return {
        stdout: '',
        stderr: `Execution service error: ${response.status}`,
        exitCode: 1,
        executionTimeMs: 0,
        timedOut: false,
      }
    }

    const data = await response.json()
    const run = data.run || {}

    return {
      stdout: (run.stdout || '').slice(0, MAX_OUTPUT_LENGTH),
      stderr: (run.stderr || '').slice(0, MAX_OUTPUT_LENGTH),
      exitCode: run.code ?? 1,
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
