import { z } from 'zod'
import { completion, parseClaudeJSON } from '@shared/services/modelRouter'
import { aiLogger } from '@shared/logger'
import { DATA_BOUNDARY_RULE } from '@shared/services/promptSecurity'
import type { CodeLanguage } from '@shared/types'

/**
 * LLM-based code "Run" — simulates execution instead of running in a sandbox.
 *
 * Why: the entire coding interview is already LLM-driven (problem generation,
 * clarifications, and SUBMISSION scoring via /api/evaluate-code all read the code
 * with the model rather than executing it). The free public Piston sandbox went
 * whitelist-only (2026-02-15), so rather than self-host an execution engine just to
 * power the convenience "Run" button, we predict the program's output with the same
 * model. Results are always flagged `simulated: true` so the UI can label them
 * "AI-estimated" — they are NOT a real run and can be wrong on complex logic,
 * randomness, performance, or exact formatting.
 */
export interface SimulatedRunResult {
  stdout: string
  stderr: string
  exitCode: number
  /** Always true — output is predicted by the model, not executed in a sandbox. */
  simulated: true
}

const MAX_OUTPUT_LENGTH = 10000

const SimResultSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int(),
})

const SYSTEM_PROMPT = `You are a precise code-execution simulator for an interview practice tool. You receive a program in a given language plus optional stdin, and you predict EXACTLY what running it would print.

${DATA_BOUNDARY_RULE}

Rules:
- Return ONLY JSON: {"stdout": string, "stderr": string, "exitCode": number}
- stdout: the exact characters the program writes to standard output — preserve newlines, spacing, and formatting. No commentary, no markdown fences, no explanation.
- stderr: the compiler/runtime diagnostics (syntax errors, exceptions with traceback, "Main method not found", etc.) if the program would fail; otherwise "".
- exitCode: 0 for a clean run; non-zero if it errors or crashes.
- Trace THIS code faithfully. Report only what this code actually does — do NOT solve the task, fix bugs, or invent output the code would not produce.
- If output depends on randomness or the clock, produce one plausible run.
- If the code is incomplete or won't compile, put the diagnostic in stderr, stdout "", exitCode 1.
- Cap very long or non-terminating output rather than looping forever.`

/**
 * Neutralize the boundary delimiters inside untrusted input so a literal `</code>`
 * or `</stdin>` in the candidate's code/stdin (e.g. a program that prints HTML, or a
 * deliberate injection) can't close the tag early and smuggle text outside the
 * DATA_BOUNDARY_RULE boundary. A zero-width space breaks the closing sequence while
 * leaving the content readable to the simulator. Codex P2 on PR #455.
 */
function neutralizeFences(s: string): string {
  return s.replace(/<(\/(?:code|stdin)>)/gi, '<\u200B$1')
}

/**
 * Simulate running `code` (with optional `stdin`) and return its predicted output.
 * Never throws — failures degrade to a friendly message so the candidate can still
 * write and Submit (the Run button is a convenience, not the scoring path).
 */
export async function simulateCodeRun(
  code: string,
  language: CodeLanguage,
  stdin: string = '',
): Promise<SimulatedRunResult> {
  if (!code.trim()) {
    return { stdout: '', stderr: 'Nothing to run — the editor is empty.', exitCode: 1, simulated: true }
  }

  const userMessage = `Language: ${language}
<stdin>
${neutralizeFences(stdin.slice(0, 10000))}
</stdin>
<code>
${neutralizeFences(code.slice(0, 50000))}
</code>

Simulate running this program and return the JSON described in the rules.`

  try {
    const result = await completion({
      taskSlot: 'interview.code-run',
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    })

    try {
      const parsed = parseClaudeJSON(result.text || '{}', SimResultSchema)
      return {
        stdout: (parsed.stdout || '').slice(0, MAX_OUTPUT_LENGTH),
        stderr: (parsed.stderr || '').slice(0, MAX_OUTPUT_LENGTH),
        exitCode: Number.isFinite(parsed.exitCode) ? parsed.exitCode : 0,
        simulated: true,
      }
    } catch (err) {
      // The model violated the "return ONLY JSON" contract — usually it replied in
      // prose (e.g. describing a compile error) or its JSON was truncated at the
      // token limit. Surface the raw text, but do NOT report a clean exit 0: a prose
      // explanation of a failure must not render under a green "success" badge, and
      // a truncated response is itself incomplete. exitCode 1 + a stderr note makes
      // the UI show the uncertain/failed cue instead.
      aiLogger.warn({ err, raw: (result.text || '').slice(0, 300) }, 'code-run simulation: JSON parse failed')
      return {
        stdout: (result.text || '').slice(0, MAX_OUTPUT_LENGTH),
        stderr: 'Output could not be fully simulated — it may be incomplete, or the program may have errored.',
        exitCode: 1,
        simulated: true,
      }
    }
  } catch (err) {
    aiLogger.error({ err, language }, 'code-run simulation failed')
    return {
      stdout: '',
      stderr: 'Could not simulate this run right now. You can still write and Submit your solution.',
      exitCode: 1,
      simulated: true,
    }
  }
}

// ─── Run against example test cases (LeetCode-style) ─────────────────────────
// Candidate feedback (2026-06-16): "the runner should be interactive with sample
// test cases like LeetCode, and I can't tell how input/output works." Examples were
// display-only. This runs the candidate's code against each example via the model
// and reports actual vs expected + pass/fail — AI-judged (no real sandbox), so the
// UI labels it estimated, but it makes the I/O contract concrete.

export interface ExampleTestResult {
  input: string
  expected: string
  actual: string
  passed: boolean
}
export interface ExampleRunResult {
  results: ExampleTestResult[]
  passedCount: number
  totalCount: number
  /** Always true — pass/fail is predicted by the model, not a real run. */
  simulated: true
}

const TestJudgmentsSchema = z.object({
  results: z.array(z.object({ actual: z.string(), passed: z.boolean() })),
})

const TEST_SYSTEM_PROMPT = `You are a code-execution simulator acting as a test harness for an interview practice tool. The candidate wrote a solution; for EACH test case you predict what THEIR code produces for that input and whether it matches the expected output.

${DATA_BOUNDARY_RULE}

Rules:
- Return ONLY JSON: {"results": [{"actual": string, "passed": boolean}, ...]} — exactly one entry per test case, IN THE SAME ORDER.
- "actual": what the candidate's code would output/return for that input. Be faithful to THEIR code, INCLUDING bugs — do not fix or solve the problem for them.
- "passed": true iff "actual" matches the expected output in meaning (ignore trivial formatting like surrounding whitespace or quote style when the value is equivalent).
- If the code is empty / unimplemented / won't compile, mark every case passed=false with "actual" briefly stating the issue (e.g. "function not implemented", "SyntaxError").
- Do not add commentary or markdown fences.`

export async function runExampleTests(
  code: string,
  language: CodeLanguage,
  examples: Array<{ input: string; output: string }>,
  problem: { title: string; description: string },
): Promise<ExampleRunResult> {
  const cases = examples.slice(0, 12).map((e) => ({
    input: (e.input || '').slice(0, 2000),
    output: (e.output || '').slice(0, 2000),
  }))

  const fail = (actual: string): ExampleRunResult => ({
    results: cases.map((c) => ({ input: c.input, expected: c.output, actual, passed: false })),
    passedCount: 0,
    totalCount: cases.length,
    simulated: true,
  })

  if (!code.trim()) return fail('Editor is empty — nothing to test.')
  if (cases.length === 0) return fail('No example test cases for this problem.')

  const userMessage = `Language: ${language}
Problem: ${neutralizeFences(problem.title.slice(0, 300))}
${neutralizeFences(problem.description.slice(0, 4000))}

<code>
${neutralizeFences(code.slice(0, 50000))}
</code>

Test cases (predict the candidate's output for each, in order):
${cases.map((c, i) => `Case ${i + 1}: input = ${neutralizeFences(c.input)} | expected = ${neutralizeFences(c.output)}`).join('\n')}

Return the JSON described in the rules.`

  try {
    const result = await completion({
      taskSlot: 'interview.code-run',
      system: TEST_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    })
    const parsed = parseClaudeJSON(result.text || '{}', TestJudgmentsSchema)
    const results: ExampleTestResult[] = cases.map((c, i) => {
      const j = parsed.results[i]
      return {
        input: c.input,
        expected: c.output,
        actual: (j?.actual ?? 'No result').slice(0, MAX_OUTPUT_LENGTH),
        passed: Boolean(j?.passed),
      }
    })
    return {
      results,
      passedCount: results.filter((r) => r.passed).length,
      totalCount: results.length,
      simulated: true,
    }
  } catch (err) {
    aiLogger.warn({ err, language }, 'runExampleTests failed')
    return fail('Could not run the example tests right now. You can still Submit.')
  }
}
