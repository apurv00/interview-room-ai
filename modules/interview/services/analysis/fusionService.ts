import { completion } from '@shared/services/modelRouter'
import { JSON_OUTPUT_RULE, DATA_BOUNDARY_RULE } from '@shared/services/promptSecurity'
import { aiLogger } from '@shared/logger'
import { FusionLlmSchema } from '@interview/validators/interview'
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
  /** Low-confidence word segments from Deepgram STT — highlights uncertain speech */
  lowConfidenceWords?: Array<{ word: string; start: number; confidence: number }>
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
  /** The actual model ID resolved by the model router (e.g. 'claude-haiku-4-5'). */
  model: string
  /** Length of the rendered user prompt, for dual-pipeline audit logging. */
  promptLength: number
}

/**
 * Runtime guard for the LLM-emitted body-language + eye-contact scores.
 *
 * Zod does `safeParse` at the boundary and the route logs drift but
 * continues with the raw object, so schema-level bounds are advisory,
 * not enforced. This function is the authoritative sanitize step:
 * any non-finite, out-of-[0,100], or non-numeric value becomes `null`.
 * Readers already treat `null` as "N/A" (page.tsx + replay UI).
 */
function sanitizeFusionScore(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  if (v < 0 || v > 100) return null
  return v
}

export async function runFusionAnalysis(input: FusionInput): Promise<FusionOutput> {
  const { prosodySegments, facialSegments, evaluations, transcript, config, includeBlendshapes, lowConfidenceWords } = input

  // Defense-in-depth flag: if the server had zero usable facial frames
  // (privacy-mode session, camera blocked mid-interview, MediaPipe
  // produced only sentinel segments), we force both fusion scores to
  // `null` after parse regardless of what Claude returned. The `-1`
  // sentinel is set by `facialAggregator.ts` when a window has no
  // frames; filtering it here matches the same filter applied when
  // building `contextData.facialSignals` below.
  const hasFacialData = facialSegments.some((f) => f.avgEyeContact !== -1)

  // Build the analysis prompt
  const systemPrompt = `You are an expert interview coach analyzing multimodal signals from a recorded mock interview. The candidate was interviewing for a ${config.role} position (${config.experience} years experience, ${config.interviewType || 'screening'} interview).

Your job is to stitch together audio, visual, and content signals into a unified coaching timeline. Focus on specific, actionable moments — not generic advice.

${DATA_BOUNDARY_RULE}

${JSON_OUTPUT_RULE}
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
    "overallBodyLanguageScore": number (0-100) or null,
    "eyeContactScore": number (0-100) or null,
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
- Score eye contact based on facial data averages
- If the context data has NO \`facialSignals\` block (privacy mode, camera off, or no valid facial frames), return \`null\` for \`overallBodyLanguageScore\` and \`eyeContactScore\` — do NOT guess. The server also enforces this as a safety net, but emitting \`null\` from the model is the preferred signal.`

  const { userPrompt, contextData } = buildUserPromptWithContext(
    prosodySegments,
    facialSegments,
    evaluations,
    transcript,
    { includeBlendshapes: includeBlendshapes === true },
    lowConfidenceWords,
  )

  // 30s safety timeout to bound the worst case. With maxDuration=60 on the
  // inline fallback path, anything longer than 30s for fusion alone risks
  // hitting the function timeout. Failing here lets the client retry cleanly
  // instead of waiting until Vercel kills the function.
  const FUSION_TIMEOUT_MS = 30_000
  const response = await Promise.race([
    completion({
      taskSlot: 'interview.fusion-analysis',
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      contextData,
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Fusion analysis timed out after ${FUSION_TIMEOUT_MS}ms`)), FUSION_TIMEOUT_MS)
    ),
  ])

  const text = response.text

  // Parse the JSON response
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    throw new Error('Fusion analysis returned no valid JSON')
  }

  // G.2: Zod-validate the LLM payload. Failure is non-fatal — we log
  // the drift and continue with the raw parsed object. `resolveEvents`
  // below handles the per-field null/index variance.
  let parsedRaw: Record<string, unknown>
  try {
    parsedRaw = JSON.parse(jsonMatch[0]) as Record<string, unknown>
  } catch (parseErr) {
    // Truncated LLM output (hit max_tokens) can produce valid-looking
    // JSON brackets that are actually incomplete — e.g. `{"timeline":[{...`
    // with a missing closing `}]}`. Surface a clear error so the caller
    // can retry or mark the analysis as failed.
    throw new Error(
      `Fusion analysis returned malformed JSON (possible token-limit truncation): ${parseErr instanceof Error ? parseErr.message : 'parse error'}`
    )
  }
  const parsedLlm = FusionLlmSchema.safeParse(parsedRaw)
  if (!parsedLlm.success) {
    aiLogger.warn(
      {
        issues: parsedLlm.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        rawPreview: text.slice(0, 300),
      },
      'fusion-analysis: LLM response failed Zod validation — continuing with raw object',
    )
  }
  const raw = parsedRaw as unknown as {
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

  // Sanitize the two scores before anything downstream reads them. Zod
  // bounds are advisory (safeParse + continue); this runtime pass is
  // authoritative.
  const bodyLanguageSanitized = sanitizeFusionScore(raw.fusionSummary.overallBodyLanguageScore)
  const eyeContactSanitized = sanitizeFusionScore(raw.fusionSummary.eyeContactScore)
  // No-facial-data override: even if Claude hallucinated a plausible
  // 65-80 score (the historical failure mode when the prompt asked for
  // a body-language score but no facialSignals context was attached),
  // the server knows whether it sent any facial data. If not, force
  // null — no amount of LLM output can trick us into displaying a
  // number we have no data to back.
  const bodyLanguageScore = hasFacialData ? bodyLanguageSanitized : null
  const eyeContactScore = hasFacialData ? eyeContactSanitized : null

  if (!hasFacialData && (raw.fusionSummary.overallBodyLanguageScore != null || raw.fusionSummary.eyeContactScore != null)) {
    aiLogger.warn(
      {
        emittedBody: raw.fusionSummary.overallBodyLanguageScore,
        emittedEye: raw.fusionSummary.eyeContactScore,
      },
      'fusion-analysis: LLM emitted facial scores despite no facial data in input — forcing null',
    )
  }
  if (hasFacialData && bodyLanguageSanitized !== raw.fusionSummary.overallBodyLanguageScore) {
    aiLogger.warn(
      { raw: raw.fusionSummary.overallBodyLanguageScore },
      'fusion-analysis: overallBodyLanguageScore out of [0,100] range — nulled',
    )
  }
  if (hasFacialData && eyeContactSanitized !== raw.fusionSummary.eyeContactScore) {
    aiLogger.warn(
      { raw: raw.fusionSummary.eyeContactScore },
      'fusion-analysis: eyeContactScore out of [0,100] range — nulled',
    )
  }

  const parsed = {
    timeline: raw.timeline,
    fusionSummary: {
      ...raw.fusionSummary,
      overallBodyLanguageScore: bodyLanguageScore,
      eyeContactScore: eyeContactScore,
      topMoments: resolveEvents(raw.fusionSummary.topMoments),
      improvementMoments: resolveEvents(raw.fusionSummary.improvementMoments),
    },
  }

  aiLogger.info(
    {
      timelineEvents: parsed.timeline.length,
      bodyLanguageScore: parsed.fusionSummary.overallBodyLanguageScore,
      eyeContactScore: parsed.fusionSummary.eyeContactScore,
      hasFacialData,
    },
    'Fusion analysis complete'
  )

  return {
    timeline: parsed.timeline,
    fusionSummary: parsed.fusionSummary,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    model: response.model,
    promptLength: userPrompt.length + JSON.stringify(contextData).length,
  }
}

function buildUserPromptWithContext(
  prosody: ProsodySegment[],
  facial: FacialSegment[],
  evaluations: AnswerEvaluation[],
  transcript: TranscriptEntry[],
  options: { includeBlendshapes: boolean } = { includeBlendshapes: false },
  lowConfidenceWords?: Array<{ word: string; start: number; confidence: number }>,
): { userPrompt: string; contextData: Record<string, unknown> } {
  const contextData: Record<string, unknown> = {}

  // Low-confidence words from Deepgram — highlights uncertain/unclear speech moments
  if (lowConfidenceWords && lowConfidenceWords.length > 0) {
    contextData.lowConfidenceWords = lowConfidenceWords.slice(0, 20) // Top 20 most uncertain words
  }

  // Audio signals — uniform array, TOON-friendly
  if (prosody.length > 0) {
    contextData.audioSignals = prosody.map((p) => ({
      questionIndex: p.questionIndex,
      timeRange: `${p.startSec.toFixed(0)}s-${p.endSec.toFixed(0)}s`,
      wpm: p.wpm,
      fillerCount: p.fillerWords.length,
      fillerExamples: p.fillerWords.slice(0, 3).map((f) => f.word).join(';'),
      pauseDuration: p.pauseDurationSec,
      confidence: p.confidenceMarker,
    }))
  }

  // Facial signals — uniform array, TOON-friendly.
  // Filter out sentinel segments (avgEyeContact === -1) where the aggregator
  // had no frames in the window. Without this filter, Math.round(-1 * 100)
  // sends eyeContact: -100 and headStability: -100 to the LLM, corrupting
  // the analysis with nonsensical negative percentages.
  const facialWithData = facial.filter((f) => f.avgEyeContact !== -1)
  if (facialWithData.length > 0) {
    contextData.facialSignals = facialWithData.map((f) => {
      const base: Record<string, unknown> = {
        questionIndex: f.questionIndex,
        timeRange: `${f.startSec.toFixed(0)}s-${f.endSec.toFixed(0)}s`,
        eyeContact: Math.round(f.avgEyeContact * 100),
        dominantExpression: f.dominantExpression,
        headStability: Math.round(f.headStability * 100),
        gestureLevel: f.gestureLevel,
      }
      if (options.includeBlendshapes && f.meanBlendshapes) {
        base.topBlendshapes = selectTopBlendshapes(f.meanBlendshapes, BLENDSHAPES_TOP_N)
      }
      return base
    })
  }

  // Content scores — uniform array, TOON-friendly
  if (evaluations.length > 0) {
    contextData.contentScores = evaluations.map((e) => ({
      questionIndex: e.questionIndex,
      question: e.question.slice(0, 100),
      relevance: e.relevance,
      structure: e.structure,
      specificity: e.specificity,
      ownership: e.ownership,
      flags: (e.flags || []).join(';'),
    }))
  }

  // Interview meta (small, keep inline)
  let metaBlock = ''
  if (transcript.length > 0) {
    const interviewerEntries = transcript.filter((t) => t.speaker === 'interviewer')
    metaBlock = `\n\nInterview: ${interviewerEntries.length} questions, ${transcript.length} transcript entries, ${Math.max(...transcript.map((t) => t.timestamp)).toFixed(0)}s duration.`
  }

  const userPrompt = `Analyze this interview and generate the multimodal coaching timeline.${metaBlock}`
  return { userPrompt, contextData }
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
