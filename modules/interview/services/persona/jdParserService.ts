import { getAnthropicClient } from '@shared/services/llmClient'
import { isFeatureEnabled } from '@shared/featureFlags'
import { logger } from '@shared/logger'
import type { IParsedJobDescription, ParsedRequirement } from '@shared/db/models/SavedJobDescription'
import { DOMAIN_COMPETENCIES, UNIVERSAL_COMPETENCIES } from '@learn'

// ─── Parse Job Description ─────────────────────────────────────────────────

export async function parseJobDescription(rawText: string): Promise<IParsedJobDescription> {
  if (!isFeatureEnabled('jd_structured_parsing')) {
    return createFallbackParsedJD(rawText)
  }

  try {
    // Build competency list for mapping
    const allCompetencies = [
      ...UNIVERSAL_COMPETENCIES,
      ...Object.values(DOMAIN_COMPETENCIES).flat(),
    ]
    const uniqueCompetencies = Array.from(new Set(allCompetencies))

    const response = await getAnthropicClient().messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: `You are a job description parser. Extract structured data from job descriptions.
Return ONLY valid JSON matching the schema below. No markdown, no explanation.

Available competencies for mapping: ${uniqueCompetencies.join(', ')}

Schema:
{
  "company": "string (company name or empty)",
  "role": "string (job title)",
  "inferredDomain": "string (one of: pm, frontend, backend, sdet, data-science, design, marketing, finance, business, sales, devops)",
  "requirements": [
    {
      "id": "req_1",
      "category": "technical|behavioral|experience|education|cultural",
      "requirement": "short description of the requirement",
      "importance": "must-have|nice-to-have",
      "targetCompetencies": ["competency_name_from_list"]
    }
  ],
  "keyThemes": ["theme1", "theme2"]
}`,
      messages: [{
        role: 'user',
        content: `Parse this job description:\n\n<job_description>\n${rawText.slice(0, 6000)}\n</job_description>`,
      }],
    })

    const text = response.content[0]?.type === 'text' ? response.content[0].text : ''

    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      logger.warn('JD parser returned no JSON, falling back')
      return createFallbackParsedJD(rawText)
    }

    const parsed = JSON.parse(jsonMatch[0])

    // Validate and normalize requirements
    const requirements: ParsedRequirement[] = (parsed.requirements || []).map((r: Record<string, unknown>, i: number) => ({
      id: (r.id as string) || `req_${i + 1}`,
      category: validateCategory(r.category as string),
      requirement: String(r.requirement || ''),
      importance: r.importance === 'nice-to-have' ? 'nice-to-have' as const : 'must-have' as const,
      targetCompetencies: Array.isArray(r.targetCompetencies)
        ? (r.targetCompetencies as string[]).filter(c => uniqueCompetencies.includes(c))
        : [],
    }))

    return {
      rawText,
      company: String(parsed.company || ''),
      role: String(parsed.role || ''),
      inferredDomain: String(parsed.inferredDomain || ''),
      requirements,
      keyThemes: Array.isArray(parsed.keyThemes) ? parsed.keyThemes.map(String) : [],
    }
  } catch (err) {
    logger.error({ err }, 'JD parsing failed')
    return createFallbackParsedJD(rawText)
  }
}

// ─── Build JD Context for Prompt Injection ──────────────────────────────────

export function buildParsedJDContext(parsedJD: IParsedJobDescription): string {
  if (!parsedJD.requirements.length) return ''

  const parts: string[] = []

  if (parsedJD.company || parsedJD.role) {
    parts.push(`TARGET: ${parsedJD.role}${parsedJD.company ? ` at ${parsedJD.company}` : ''}`)
  }

  const mustHaves = parsedJD.requirements.filter(r => r.importance === 'must-have')
  const niceToHaves = parsedJD.requirements.filter(r => r.importance === 'nice-to-have')

  if (mustHaves.length > 0) {
    parts.push('MUST-HAVE REQUIREMENTS (design questions to probe these):')
    for (const r of mustHaves) {
      parts.push(`  - ${r.requirement} [${r.category}]`)
    }
  }

  if (niceToHaves.length > 0) {
    parts.push('NICE-TO-HAVE REQUIREMENTS:')
    for (const r of niceToHaves.slice(0, 5)) {
      parts.push(`  - ${r.requirement} [${r.category}]`)
    }
  }

  if (parsedJD.keyThemes.length > 0) {
    parts.push(`KEY THEMES: ${parsedJD.keyThemes.join(', ')}`)
  }

  return `JOB DESCRIPTION ANALYSIS:\n${parts.join('\n')}`
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function validateCategory(cat: string): ParsedRequirement['category'] {
  const valid = ['technical', 'behavioral', 'experience', 'education', 'cultural'] as const
  return valid.includes(cat as typeof valid[number])
    ? cat as ParsedRequirement['category']
    : 'behavioral'
}

function createFallbackParsedJD(rawText: string): IParsedJobDescription {
  return {
    rawText,
    company: '',
    role: '',
    inferredDomain: '',
    requirements: [],
    keyThemes: [],
  }
}
