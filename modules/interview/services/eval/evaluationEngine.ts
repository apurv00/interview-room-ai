import { completion } from '@shared/services/modelRouter'
import { DATA_BOUNDARY_RULE, JSON_OUTPUT_RULE } from '@shared/services/promptSecurity'
import { connectDB } from '@shared/db/connection'
import { EvaluationRubric, InterviewDepth } from '@shared/db/models'
import type { IEvaluationRubric, RubricDimension } from '@shared/db/models'
import type { AnswerEvaluation } from '@shared/types'
import { isFeatureEnabled } from '@shared/featureFlags'
import { FALLBACK_DEPTHS } from '@shared/db/seed'
import { logger } from '@shared/logger'

// ─── Rubric Registry ────────────────────────────────────────────────────────

export async function getRubric(
  domain: string,
  interviewType: string,
  seniorityBand: string
): Promise<IEvaluationRubric | null> {
  if (!isFeatureEnabled('rubric_registry')) return null

  try {
    await connectDB()

    // Try exact match first, then progressively broaden
    const rubric = await EvaluationRubric.findOne({
      $or: [
        { domain, interviewType, seniorityBand, isActive: true },
        { domain, interviewType, seniorityBand: '*', isActive: true },
        { domain: '*', interviewType, seniorityBand: '*', isActive: true },
        { domain: '*', interviewType: '*', seniorityBand: '*', isActive: true },
      ],
    }).sort({ version: -1 }).lean()

    return rubric
  } catch (err) {
    logger.error({ err }, 'Failed to fetch rubric')
    return null
  }
}

// ─── Get Scoring Dimensions ─────────────────────────────────────────────────

export async function getScoringDimensions(
  domain: string,
  interviewType: string,
  seniorityBand: string,
  preloadedRubric?: { dimensions?: RubricDimension[] } | null,
): Promise<RubricDimension[]> {
  // Use pre-loaded rubric when provided (avoids a redundant DB fetch when the
  // session config cache already fetched it). Explicit undefined means "not
  // provided" — fall through to getRubric(). Explicit null means "no rubric
  // available" — skip DB lookup and proceed to fallbacks.
  const rubric =
    preloadedRubric !== undefined ? preloadedRubric : await getRubric(domain, interviewType, seniorityBand)
  if (rubric?.dimensions?.length) {
    return rubric.dimensions
  }

  // Fall back to InterviewDepth scoringDimensions
  try {
    await connectDB()
    const depth = await InterviewDepth.findOne({ slug: interviewType, isActive: true }).lean()
    if (depth?.scoringDimensions?.length) {
      return depth.scoringDimensions.map(d => ({
        name: d.name,
        label: d.label,
        weight: d.weight,
        description: '',
        scoringGuide: { excellent: '', good: '', adequate: '', weak: '' },
      }))
    }
  } catch { /* continue */ }

  // Fall back to built-in defaults
  const fallback = FALLBACK_DEPTHS.find(d => d.slug === interviewType)
  if (fallback?.scoringDimensions?.length) {
    return fallback.scoringDimensions.map(d => ({
      name: d.name,
      label: d.label,
      weight: d.weight,
      description: '',
      scoringGuide: { excellent: '', good: '', adequate: '', weak: '' },
    }))
  }

  // Ultimate fallback
  return [
    { name: 'relevance', label: 'Relevance', weight: 0.25, description: '', scoringGuide: { excellent: '', good: '', adequate: '', weak: '' } },
    { name: 'structure', label: 'STAR Structure', weight: 0.25, description: '', scoringGuide: { excellent: '', good: '', adequate: '', weak: '' } },
    { name: 'specificity', label: 'Specificity', weight: 0.25, description: '', scoringGuide: { excellent: '', good: '', adequate: '', weak: '' } },
    { name: 'ownership', label: 'Ownership', weight: 0.25, description: '', scoringGuide: { excellent: '', good: '', adequate: '', weak: '' } },
  ]
}

// ─── Build Rubric-Enhanced Evaluation Prompt ─────────────────────────────────

export function buildRubricPromptSection(dimensions: RubricDimension[]): string {
  const lines: string[] = ['Score on these dimensions (integer 0–100):']

  for (const dim of dimensions) {
    let line = `- ${dim.name}: ${dim.label} (weight: ${dim.weight})`
    if (dim.description) {
      line += ` — ${dim.description}`
    }
    if (dim.scoringGuide?.excellent) {
      line += `\n  80-100: ${dim.scoringGuide.excellent}`
      line += `\n  60-79: ${dim.scoringGuide.good}`
      line += `\n  40-59: ${dim.scoringGuide.adequate}`
      line += `\n  0-39: ${dim.scoringGuide.weak}`
    }
    lines.push(line)
  }

  return lines.join('\n')
}

// ─── Structured Evaluation (Separate from Live Interview) ────────────────────

interface StructuredEvaluationInput {
  domain: string
  interviewType: string
  seniorityBand: string
  question: string
  answer: string
  questionIndex: number
  sessionBriefContext?: string     // from personalization engine
  jobDescription?: string
  /**
   * Optional sampling temperature override. Defaults to the SDK default (≈1.0).
   * Used by the offline evaluation harness to drive determinism (temperature: 0).
   * Do NOT set this from production code paths without intent.
   */
  temperature?: number
}

interface StructuredEvaluationResult {
  scores: Record<string, number>
  weightedScore: number
  needsFollowUp: boolean
  followUpQuestion: string | null
  flags: string[]
  strengthTags: string[]
  weaknessTags: string[]
  evidenceSpans: string[]
}

export async function evaluateStructured(
  input: StructuredEvaluationInput
): Promise<StructuredEvaluationResult | null> {
  if (!isFeatureEnabled('evaluation_engine_v2')) return null

  try {
    const dimensions = await getScoringDimensions(input.domain, input.interviewType, input.seniorityBand)

    const dimensionPrompt = buildRubricPromptSection(dimensions)
    const dimensionNames = dimensions.map(d => `"${d.name}": number`).join(', ')

    let jdContext = ''
    if (input.jobDescription) {
      jdContext = `\n\n<job_description>\n${input.jobDescription.slice(0, 3000)}\n</job_description>`
    }

    const sessionContext = input.sessionBriefContext
      ? `\n\nPERSONALIZATION CONTEXT:\n${input.sessionBriefContext}`
      : ''

    const systemPrompt = `${DATA_BOUNDARY_RULE}

You are an expert interview evaluator. Score the candidate's answer using the provided rubric. Be objective, evidence-based, and specific.${jdContext}${sessionContext}`

    const userPrompt = `Question: "${input.question}"

<candidate_answer>
${input.answer}
</candidate_answer>

${dimensionPrompt}

Also provide:
- needsFollowUp: true if answer is vague, too short (<30 words), or missing key info
- followUpQuestion: if needsFollowUp, provide a probing follow-up
- flags: red-flag strings (empty array if none)
- strengthTags: what the candidate did well (1-3 tags)
- weaknessTags: areas for improvement (1-3 tags)
- evidenceSpans: specific phrases from the answer supporting your scores (1-3 spans)

${JSON_OUTPUT_RULE}
{
  "scores": { ${dimensionNames} },
  "needsFollowUp": boolean,
  "followUpQuestion": string | null,
  "flags": string[],
  "strengthTags": string[],
  "weaknessTags": string[],
  "evidenceSpans": string[]
}`

    const completionResult = await completion({
      taskSlot: 'interview.evaluation-engine-v2',
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      ...(typeof input.temperature === 'number' ? { temperature: input.temperature } : {}),
    })

    const raw = completionResult.text || '{}'
    const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    const result = JSON.parse(cleaned)

    // Calculate weighted score
    const scores = result.scores || {}
    let weightedScore = 0
    for (const dim of dimensions) {
      weightedScore += (scores[dim.name] || 50) * dim.weight
    }

    return {
      scores,
      weightedScore: Math.round(weightedScore),
      needsFollowUp: result.needsFollowUp ?? false,
      followUpQuestion: result.followUpQuestion ?? null,
      flags: result.flags ?? [],
      strengthTags: result.strengthTags ?? [],
      weaknessTags: result.weaknessTags ?? [],
      evidenceSpans: result.evidenceSpans ?? [],
    }
  } catch (err) {
    logger.error({ err }, 'Structured evaluation failed')
    return null
  }
}

// ─── Full Session Evaluation ─────────────────────────────────────────────────

interface SessionEvaluationInput {
  domain: string
  interviewType: string
  seniorityBand: string
  evaluations: AnswerEvaluation[]
  additionalResults?: StructuredEvaluationResult[]
}

export interface SessionEvaluationSummary {
  dimensionAverages: Record<string, number>
  overallWeightedScore: number
  topStrengths: string[]
  topWeaknesses: string[]
  allFlags: string[]
  competencyBreakdown: Record<string, {
    score: number
    trend: string
    evidence: string[]
  }>
}

export async function evaluateSession(
  input: SessionEvaluationInput
): Promise<SessionEvaluationSummary> {
  const { evaluations, additionalResults } = input
  const dimensions = await getScoringDimensions(input.domain, input.interviewType, input.seniorityBand)

  // Aggregate scores across all evaluations
  const dimScores: Record<string, number[]> = {}

  // From standard evaluations
  for (const ev of evaluations) {
    pushToMap(dimScores, 'relevance', ev.relevance)
    pushToMap(dimScores, 'structure', ev.structure)
    pushToMap(dimScores, 'specificity', ev.specificity)
    pushToMap(dimScores, 'ownership', ev.ownership)
    if (ev.jdAlignment != null) pushToMap(dimScores, 'jdAlignment', ev.jdAlignment)
  }

  // From structured evaluations
  if (additionalResults) {
    for (const result of additionalResults) {
      for (const [key, value] of Object.entries(result.scores)) {
        pushToMap(dimScores, key, value)
      }
    }
  }

  // Calculate averages
  const dimensionAverages: Record<string, number> = {}
  for (const [key, scores] of Object.entries(dimScores)) {
    dimensionAverages[key] = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
  }

  // Calculate weighted overall score
  let overallWeightedScore = 0
  let totalWeight = 0
  for (const dim of dimensions) {
    const score = dimensionAverages[dim.name]
    if (score !== undefined) {
      overallWeightedScore += score * dim.weight
      totalWeight += dim.weight
    }
  }
  overallWeightedScore = totalWeight > 0 ? Math.round(overallWeightedScore / totalWeight) : 50

  // Aggregate strengths, weaknesses, flags
  const allStrengths = additionalResults?.flatMap(r => r.strengthTags) || []
  const allWeaknessTags = additionalResults?.flatMap(r => r.weaknessTags) || []
  const allFlags = [
    ...evaluations.flatMap(e => e.flags),
    ...(additionalResults?.flatMap(r => r.flags) || []),
  ]

  // Deduplicate
  const topStrengths = Array.from(new Set(allStrengths)).slice(0, 5)
  const topWeaknesses = Array.from(new Set(allWeaknessTags)).slice(0, 5)

  // Build competency breakdown
  const competencyBreakdown: Record<string, { score: number; trend: string; evidence: string[] }> = {}
  for (const [key, score] of Object.entries(dimensionAverages)) {
    competencyBreakdown[key] = {
      score,
      trend: 'stable',
      evidence: (additionalResults?.flatMap(r => r.evidenceSpans) || []).slice(0, 3),
    }
  }

  return {
    dimensionAverages,
    overallWeightedScore,
    topStrengths,
    topWeaknesses,
    allFlags: Array.from(new Set(allFlags)),
    competencyBreakdown,
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function pushToMap(map: Record<string, number[]>, key: string, value: number | undefined) {
  if (value === undefined) return
  if (!map[key]) map[key] = []
  map[key].push(value)
}
