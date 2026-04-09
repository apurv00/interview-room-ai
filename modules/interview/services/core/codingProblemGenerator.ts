import { completion } from '@shared/services/modelRouter'
import { JSON_OUTPUT_RULE } from '@shared/services/promptSecurity'
import { aiLogger } from '@shared/logger'
import type { CodingProblem } from '@interview/config/codingProblems'
import type { CodeLanguage } from '@shared/types'

/**
 * Generate a fresh coding problem using Claude when the static pool is exhausted.
 * Returns a problem in the same format as the static bank.
 */
export async function generateCodingProblem(
  domain: string,
  experience: string,
  solvedProblemIds: string[]
): Promise<CodingProblem | null> {
  const difficulty = experience === '7+' ? 'hard' : experience === '3-6' ? 'medium' : 'easy'

  const domainContext: Record<string, string> = {
    backend: 'data structures, algorithms, system-oriented problems (caching, queues, rate limiting)',
    frontend: 'JavaScript fundamentals, DOM manipulation, async patterns, component design',
    'data-science': 'data manipulation, statistical algorithms, ML pipeline components, numerical computing',
    sdet: 'test framework implementation, data validation, automation utilities, edge case handling',
  }

  try {
    const result = await completion({
      taskSlot: 'interview.coding-problem-gen',
      system: `You are an expert coding interview problem designer. Generate a unique coding problem that has NOT been asked before. The problem should be practical, well-defined, and testable.

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
        content: `Generate a ${difficulty} coding problem for a ${domain} engineer (${experience} years experience).

Domain focus: ${domainContext[domain] || 'general algorithms and data structures'}

Problems the candidate has already solved (DO NOT generate similar problems):
${solvedProblemIds.slice(0, 20).join(', ')}

Generate something fresh and different from the above.`,
      }],
    })

    const text = result.text || '{}'
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null

    const parsed = JSON.parse(jsonMatch[0])

    // Ensure the generated problem has all required fields
    const problem: CodingProblem = {
      id: `ai-${parsed.id || `generated-${Date.now()}`}`,
      title: parsed.title || 'AI Generated Problem',
      description: parsed.description || '',
      examples: Array.isArray(parsed.examples) ? parsed.examples : [],
      constraints: Array.isArray(parsed.constraints) ? parsed.constraints : [],
      difficulty,
      applicableDomains: [domain],
      hints: Array.isArray(parsed.hints) ? parsed.hints : [],
      starterCode: parsed.starterCode || {
        python: 'def solution():\n    pass',
        javascript: 'function solution() {\n  \n}',
      },
      expectedTimeMinutes: difficulty === 'easy' ? 10 : difficulty === 'medium' ? 15 : 25,
      tags: Array.isArray(parsed.tags) ? parsed.tags : ['ai-generated'],
    }

    aiLogger.info(
      { problemId: problem.id, title: problem.title, difficulty, domain },
      'AI-generated coding problem'
    )

    return problem
  } catch (err) {
    aiLogger.error({ err, domain, difficulty }, 'Failed to generate coding problem')
    return null
  }
}
