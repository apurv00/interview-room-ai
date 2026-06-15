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
${stdin.slice(0, 10000)}
</stdin>
<code>
${code.slice(0, 50000)}
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
      // Model didn't return clean JSON — surface its raw text as stdout rather than
      // failing, so the candidate still sees something useful.
      aiLogger.warn({ err, raw: (result.text || '').slice(0, 300) }, 'code-run simulation: JSON parse failed')
      return {
        stdout: (result.text || '').slice(0, MAX_OUTPUT_LENGTH),
        stderr: '',
        exitCode: 0,
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
