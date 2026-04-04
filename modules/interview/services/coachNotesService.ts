import { getAnthropicClient } from '@shared/services/llmClient'
import { aiLogger } from '@shared/logger'

export interface CoachNote {
  momentSec: number
  questionIndex: number
  originalText: string
  suggestion: string
  rewriteExample: string
  dimension: string
}

interface GenerateCoachNotesInput {
  transcript: Array<{ speaker: string; text: string; timestamp: number; questionIndex?: number | null }>
  evaluations: Array<Record<string, unknown>>
  improvementMoments: Array<{ startSec: number; endSec: number; title: string; description: string; questionIndex?: number }>
}

/**
 * Generate per-moment rewrite suggestions for interview improvement moments.
 * Each coach note includes what the candidate said, what to improve, and a rewrite example.
 */
export async function generateCoachNotes(input: GenerateCoachNotesInput): Promise<CoachNote[]> {
  const { transcript, evaluations, improvementMoments } = input

  if (!improvementMoments?.length || !transcript?.length) return []

  // Take up to 5 improvement moments
  const moments = improvementMoments.slice(0, 5)

  // For each moment, find the candidate's answer near that timestamp
  const momentContexts = moments.map(moment => {
    // Find candidate transcript entries near this moment
    const candidateEntries = transcript.filter(
      t => t.speaker === 'candidate' && t.questionIndex === moment.questionIndex
    )
    const originalText = candidateEntries.map(e => e.text).join(' ').slice(0, 500)

    // Find the matching evaluation
    const evaluation = evaluations.find(
      (e: Record<string, unknown>) => (e.questionIndex as number) === moment.questionIndex
    )

    // Determine weakest dimension
    const dims = ['relevance', 'structure', 'specificity', 'ownership'] as const
    let weakestDim = 'structure'
    let lowestScore = 100
    if (evaluation) {
      for (const dim of dims) {
        const score = evaluation[dim] as number
        if (score !== undefined && score < lowestScore) {
          lowestScore = score
          weakestDim = dim
        }
      }
    }

    return {
      momentSec: moment.startSec,
      questionIndex: moment.questionIndex || 0,
      originalText,
      title: moment.title,
      description: moment.description,
      dimension: weakestDim,
    }
  }).filter(m => m.originalText.length > 10)

  if (momentContexts.length === 0) return []

  try {
    const client = getAnthropicClient()

    const momentsJson = JSON.stringify(momentContexts.map(m => ({
      originalText: m.originalText,
      issue: m.description,
      dimension: m.dimension,
    })))

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system: `You are an expert interview coach. For each improvement moment, provide:
1. A specific suggestion (1-2 sentences) on what to change
2. A rewritten example showing how the candidate could have answered better

Return JSON array: [{ "suggestion": "...", "rewriteExample": "..." }]
Keep rewrites concise (2-4 sentences). Preserve the candidate's facts but improve structure, specificity, and impact.`,
      messages: [{
        role: 'user',
        content: `Generate coaching rewrites for these interview moments:\n${momentsJson}`,
      }],
    })

    const responseText = message.content[0].type === 'text' ? message.content[0].text : ''

    // Parse JSON from response
    const jsonMatch = responseText.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return []

    const parsed = JSON.parse(jsonMatch[0]) as Array<{ suggestion: string; rewriteExample: string }>

    return momentContexts.map((ctx, i) => ({
      momentSec: ctx.momentSec,
      questionIndex: ctx.questionIndex,
      originalText: ctx.originalText,
      suggestion: parsed[i]?.suggestion || '',
      rewriteExample: parsed[i]?.rewriteExample || '',
      dimension: ctx.dimension,
    })).filter(n => n.suggestion)
  } catch (err) {
    aiLogger.error({ err }, 'Failed to generate coach notes')
    return []
  }
}
