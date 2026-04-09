import { completion } from '@shared/services/modelRouter'
import { aiLogger } from '@shared/logger'
import type {
  ProsodySegment,
  FacialSegment,
  TimelineEvent,
  FusionSummary,
} from '@shared/types/multimodal'
import type { AnswerEvaluation, TranscriptEntry, InterviewConfig } from '@shared/types'

// Number of top blendshapes (by mean score within the window) to include
// per facial segment in the enhanced variant of the dual-pipeline run.
// 8 keeps the prompt footprint manageable while still giving Claude more
// signal than the 5-class expression label alone.
const BLENDSHAPES_TOP_N = 8

interface FusionInput {
  prosodySegments: ProsodySegment[]
  facialSegments: FacialSegment[]
  evaluations: AnswerEvaluation[]
  transcript: TranscriptEntry[]
  config: InterviewConfig
  /**
   * When true, the user prompt includes per-segment blendshape summary
   * statistics alongside the existing categorical expression label. When
   * false (default, and what production uses today), the facial block is
   * restricted to the categorical label — this is the baseline variant in
   * the dual-pipeline comparison experiment.
   */
  includeBlendshapes?: boolean
}

interface FusionOutput {
  timeline: TimelineEvent[]
  fusionSummary: FusionSummary
  inputTokens: number
  outputTokens: number
  /** Length of the rendered user prompt, for dual-pipeline audit logging. */
  promptLength: number
}

export async function runFusionAnalysis(input: FusionInput): Promise<FusionOutput> {
  const { prosodySegments, facialSegments, evaluations, transcript, config, includeBlendshapes } = input

  // Build the analysis prompt
  const systemPrompt = `You are an expert interview coach analyzing multimodal signals from a recorded mock interview. The candidate was interviewing for a ${config.role} position (${config.experience} years experience, ${config.interviewType || 'screening'} interview).

Your job is to stitch together audio, visual, and content signals into a unified coaching timeline. Focus on specific, actionable moments — not generic advice.

Return ONLY valid JSON matching this exact schema:
{
  "timeline": [
    {
      "startSec": number,
      "endSec": number,
      "type": "strength" | "improvement" | "observation" | "coaching_tip",
      "signal": "audio" | "facial" | "content" | "fused",
      "title": "short title (5-8 words)",
      "description": "specific coaching insight (1-2 sentences)",
      "severity": "positive" | "neutral" | "attention",
      "questionIndex": number
    }
  ],
  "fusionSummary": {
    "overallBodyLanguageScore": number (0-100),
    "eyeContactScore": number (0-100),
    "confidenceProgression": "one sentence on how confidence changed",
    "topMoments": [3 indices into timeline array for best moments],
    "improvementMoments": [3 indices into timeline array for worst moments],
    "coachingTips": ["3 specific, actionable coaching tips"]
  }
}

Guidelines:
- Generate 6-10 timeline events covering the full interview
- Prioritize "fused" signals that combine multiple modalities (e.g., filler words + loss of eye contact = nervousness)
- Include both strengths and areas for improvement
- Tie coaching tips to specific timestamps when possible
- Score body language based on eye contact, expressions, and head stability
- Score eye contact based on facial data averages`

  const userPrompt = buildUserPrompt(
    prosodySegments,
    facialSegments,
    evaluations,
    transcript,
    { includeBlendshapes: includeBlendshapes === true }
  )

  const response = await completion({
    taskSlot: 'interview.fusion-analysis',
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  })

  const text = response.text

  // Parse the JSON response
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    throw new Error('Fusion analysis returned no valid JSON')
  }

  const raw = JSON.parse(jsonMatch[0]) as {
    timeline: TimelineEvent[]
    fusionSummary: Omit<FusionSummary, 'topMoments' | 'improvementMoments'> & {
      topMoments: number[] | TimelineEvent[]
      improvementMoments: number[] | TimelineEvent[]
    }
  }

  // Resolve indices to full TimelineEvent objects if needed
  const resolveEvents = (items: number[] | TimelineEvent[]): TimelineEvent[] => {
    if (items.length === 0) return []
    if (typeof items[0] === 'number') {
      return (items as number[]).map((i) => {
        if (i < 0 || i >= raw.timeline.length) {
          aiLogger.warn({ index: i, timelineLength: raw.timeline.length }, 'Fusion: out-of-bounds timeline index from Claude')
          return undefined as unknown as TimelineEvent
        }
        return raw.timeline[i]
      }).filter(Boolean)
    }
    return items as TimelineEvent[]
  }

  const parsed = {
    timeline: raw.timeline,
    fusionSummary: {
      ...raw.fusionSummary,
      topMoments: resolveEvents(raw.fusionSummary.topMoments),
      improvementMoments: resolveEvents(raw.fusionSummary.improvementMoments),
    },
  }

  aiLogger.info(
    {
      timelineEvents: parsed.timeline.length,
      bodyLanguageScore: parsed.fusionSummary.overallBodyLanguageScore,
      eyeContactScore: parsed.fusionSummary.eyeContactScore,
    },
    'Fusion analysis complete'
  )

  return {
    timeline: parsed.timeline,
    fusionSummary: parsed.fusionSummary,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    promptLength: userPrompt.length,
  }
}

function buildUserPrompt(
  prosody: ProsodySegment[],
  facial: FacialSegment[],
  evaluations: AnswerEvaluation[],
  transcript: TranscriptEntry[],
  options: { includeBlendshapes: boolean } = { includeBlendshapes: false }
): string {
  const sections: string[] = []

  // Audio signals
  if (prosody.length > 0) {
    const audioData = prosody.map((p) => ({
      questionIndex: p.questionIndex,
      timeRange: `${p.startSec.toFixed(0)}s - ${p.endSec.toFixed(0)}s`,
      wpm: p.wpm,
      fillerCount: p.fillerWords.length,
      fillerExamples: p.fillerWords.slice(0, 3).map((f) => f.word),
      pauseDuration: `${p.pauseDurationSec}s`,
      confidence: p.confidenceMarker,
    }))
    sections.push(`<audio_signals>\n${JSON.stringify(audioData, null, 2)}\n</audio_signals>`)
  }

  // Facial signals
  if (facial.length > 0) {
    const facialData = facial.map((f) => {
      const base: Record<string, unknown> = {
        questionIndex: f.questionIndex,
        timeRange: `${f.startSec.toFixed(0)}s - ${f.endSec.toFixed(0)}s`,
        eyeContact: `${(f.avgEyeContact * 100).toFixed(0)}%`,
        dominantExpression: f.dominantExpression,
        headStability: `${(f.headStability * 100).toFixed(0)}%`,
        gestureLevel: f.gestureLevel,
      }
      // Enhanced variant: enrich each segment with the top-N blendshapes
      // (by mean score within the window). Baseline variant (the default)
      // leaves the categorical label alone.
      if (options.includeBlendshapes && f.meanBlendshapes) {
        base.topBlendshapes = selectTopBlendshapes(f.meanBlendshapes, BLENDSHAPES_TOP_N)
      }
      return base
    })
    sections.push(`<facial_signals>\n${JSON.stringify(facialData, null, 2)}\n</facial_signals>`)
  }

  // Content scores
  if (evaluations.length > 0) {
    const contentData = evaluations.map((e) => ({
      questionIndex: e.questionIndex,
      question: e.question.slice(0, 100),
      relevance: e.relevance,
      structure: e.structure,
      specificity: e.specificity,
      ownership: e.ownership,
      flags: e.flags,
    }))
    sections.push(`<content_scores>\n${JSON.stringify(contentData, null, 2)}\n</content_scores>`)
  }

  // Skip full transcript — evaluations already contain questions and scores.
  // Only include question count and total duration for context.
  if (transcript.length > 0) {
    const interviewerEntries = transcript.filter((t) => t.speaker === 'interviewer')
    sections.push(`<interview_meta>\n${JSON.stringify({
      totalQuestions: interviewerEntries.length,
      totalTranscriptEntries: transcript.length,
      durationSec: Math.max(...transcript.map((t) => t.timestamp)),
    })}\n</interview_meta>`)
  }

  return `Analyze this interview and generate the multimodal coaching timeline:\n\n${sections.join('\n\n')}`
}

/**
 * Pick the top-N blendshapes from a window by mean score (descending).
 * Returns a compact `{name: value}` map with values rounded to 3 decimals.
 * Used only by the enhanced variant of the dual-pipeline comparison — the
 * baseline variant never sees blendshape data in the prompt.
 */
function selectTopBlendshapes(
  means: Record<string, number>,
  n: number
): Record<string, number> {
  const entries = Object.entries(means)
    .filter(([, v]) => v > 0.02) // drop near-zero noise
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
  const top: Record<string, number> = {}
  for (const [k, v] of entries) {
    top[k] = parseFloat(v.toFixed(3))
  }
  return top
}
