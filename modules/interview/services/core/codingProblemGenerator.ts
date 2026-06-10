import { completion } from '@shared/services/modelRouter'
import { JSON_OUTPUT_RULE } from '@shared/services/promptSecurity'
import { aiLogger } from '@shared/logger'
import { sanitizeGeneratedText } from '@shared/services/sanitizeGeneratedText'
import type { CodingProblem } from '@interview/config/codingProblems'

/**
 * Per-role focus for AI-generated coding problems. Keep tasks RUNNABLE in the
 * Python/JS harness — for data/ML roles that means pandas/numpy data-manipulation,
 * not SQL (which the runner can't execute).
 */
const DOMAIN_FOCUS: Record<string, string> = {
  backend: 'data structures, algorithms, and system-oriented problems (caching, queues, rate limiting, idempotency)',
  frontend: 'JavaScript/TypeScript fundamentals, DOM/async patterns, state transforms, and component logic',
  fullstack: 'full-stack logic — request/response transforms, API data shaping, validation, and client-server data flow',
  sdet: 'test-framework utilities, data validation, fixtures/assertions, and thorough edge-case handling',
  devops: 'automation/scripting logic — log parsing, config processing, retry/backoff, scheduling, and resource bin-packing',
  mobile: 'mobile-flavored logic — list pagination/virtualization, cache + offline-sync reconciliation, debouncing, and state diffing',
  'data-science': 'data manipulation, statistical routines, and ML pipeline components (numpy/pandas, runnable in Python)',
  'ml-engineer': 'ML-flavored Python — vectorized numpy transforms, implementing a metric (precision/recall/F1/AUC), a sampling or train/val-split routine, or feature encoding (runnable in Python; NOT a plain array puzzle)',
  'data-analyst': 'pandas/Python data-wrangling a real analyst writes — groupby/pivot/merge, time-series aggregation, cohort/funnel computation, dedup/cleaning (runnable in Python; favor real analytics tasks over generic array puzzles)',
}

/**
 * Generate a fresh coding problem, tailored to the candidate's role and — when a
 * resume/profile is available — their background. Falls back to the static pool
 * (caller-side) on null. Returns a problem in the same format as the static bank.
 */
export async function generateCodingProblem(
  domain: string,
  experience: string,
  solvedProblemIds: string[],
  resumeContext?: string,
): Promise<CodingProblem | null> {
  const difficulty = experience === '7+' ? 'hard' : experience === '3-6' ? 'medium' : 'easy'
  const focus = DOMAIN_FOCUS[domain] || 'general algorithms and data structures'

  try {
    const result = await completion({
      taskSlot: 'interview.coding-problem-gen',
      system: `You are an expert coding interview problem designer. Generate a unique, practical, well-defined, testable problem that is RUNNABLE in a Python/JavaScript code runner (no SQL, no external services).

${JSON_OUTPUT_RULE}
{
  "id": "unique-kebab-case-id",
  "title": "Problem Title",
  "description": "Clear problem description with input/output format",
  "examples": [{"input": "example input", "output": "expected output", "explanation": "optional"}],
  "constraints": ["constraint 1", "constraint 2"],
  "hints": ["hint 1", "hint 2"],
  "starterCode": {"python": "def solution():\\n    pass", "javascript": "function solution() {\\n  \\n}"},
  "tags": ["relevant", "tags"]
}`,
      messages: [{
        role: 'user',
        content: `Generate a ${difficulty} coding problem for a ${domain} candidate (${experience} years experience).

Domain focus (the problem MUST exercise this): ${focus}
${resumeContext ? `\nCandidate background — tailor the problem's SCENARIO/framing to this where it fits naturally, but the problem must still test the domain focus above (do NOT force an unrelated reference):\n${resumeContext.slice(0, 1200)}\n` : ''}
Problems the candidate has already solved (DO NOT generate similar problems):
${solvedProblemIds.slice(0, 20).join(', ')}

Generate something fresh and different from the above. English only.`,
      }],
    })

    const text = result.text || '{}'
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null

    const parsed = JSON.parse(jsonMatch[0])

    const problem: CodingProblem = {
      id: `ai-${parsed.id || `generated-${Date.now()}`}`,
      title: sanitizeGeneratedText(parsed.title) || 'AI Generated Problem',
      description: sanitizeGeneratedText(parsed.description) || '',
      examples: Array.isArray(parsed.examples)
        ? parsed.examples.map((e: { input?: string; output?: string; explanation?: string }) => ({
            input: sanitizeGeneratedText(e.input),
            output: sanitizeGeneratedText(e.output),
            ...(e.explanation ? { explanation: sanitizeGeneratedText(e.explanation) } : {}),
          }))
        : [],
      constraints: Array.isArray(parsed.constraints) ? parsed.constraints.map(sanitizeGeneratedText) : [],
      difficulty,
      applicableDomains: [domain],
      hints: Array.isArray(parsed.hints) ? parsed.hints.map(sanitizeGeneratedText) : [],
      starterCode: parsed.starterCode || {
        python: 'def solution():\n    pass',
        javascript: 'function solution() {\n  \n}',
      },
      expectedTimeMinutes: difficulty === 'easy' ? 10 : difficulty === 'medium' ? 15 : 25,
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(sanitizeGeneratedText) : ['ai-generated'],
    }

    aiLogger.info(
      { problemId: problem.id, title: problem.title, difficulty, domain, personalized: !!resumeContext },
      'AI-generated coding problem'
    )

    return problem
  } catch (err) {
    aiLogger.error({ err, domain, difficulty }, 'Failed to generate coding problem')
    return null
  }
}
