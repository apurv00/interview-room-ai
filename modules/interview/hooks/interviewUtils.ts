import type {
  AnswerEvaluation,
  AvatarEmotion,
  PerformanceSignal,
  ProbeType,
  PushbackTone,
  ThreadEntry,
  ThreadSummary,
} from '@shared/types'
import type { Duration } from '@shared/types'
import { getMinimumTopics } from '@interview/config/interviewConfig'

/**
 * Compute a rolling performance signal from all evaluations so far.
 * Used to adapt question difficulty dynamically.
 */
export function computePerformanceSignal(evals: AnswerEvaluation[]): PerformanceSignal {
  const scored = evals.filter((e) => e.status !== 'failed')
  if (scored.length < 2) return 'calibrating'
  const avg = scored.reduce((sum, e) =>
    sum + (e.relevance + e.structure + e.specificity + e.ownership) / 4, 0
  ) / scored.length
  if (avg >= 70) return 'strong'
  if (avg >= 45) return 'on_track'
  return 'struggling'
}

/**
 * Decide whether to probe deeper on the current topic or advance to the next one.
 */
export function shouldProbeOrAdvance(
  evaluation: AnswerEvaluation,
  timeRemaining: number,
  completedThreadsCount: number,
  duration: Duration,
): 'probe' | 'advance' {
  const probe = evaluation.probeDecision
  if (!probe?.shouldProbe) return 'advance'
  if (timeRemaining < 60) return 'advance'
  // Don't probe if we haven't covered minimum topics and are running low on time
  const topicsNeeded = getMinimumTopics(duration) - completedThreadsCount
  const roughTimePerTopic = 90 // ~1.5 min per topic
  if (topicsNeeded > 0 && topicsNeeded * roughTimePerTopic > timeRemaining) return 'advance'
  return 'probe'
}

type ProbeQuestionContext = {
  question?: string
  answer?: string
  previousProbe?: string
}

const PROBE_TARGET_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how',
  'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was',
  'were', 'what', 'when', 'where', 'which', 'who', 'why', 'with', 'you',
  'your',
])

function normalizeProbeTarget(target?: string | null): string {
  return (target ?? '').replace(/\s+/g, ' ').replace(/[?.!,;:]+$/g, '').trim()
}

function significantTokens(text?: string | null): string[] {
  const tokens = (text ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []
  return Array.from(new Set(tokens.filter((token) =>
    token.length > 2 && !PROBE_TARGET_STOP_WORDS.has(token)
  )))
}

function overlapRatio(targetTokens: string[], sourceText?: string | null): number {
  if (targetTokens.length === 0 || !sourceText) return 0
  const source = new Set(significantTokens(sourceText))
  if (source.size === 0) return 0
  const overlap = targetTokens.filter((token) => source.has(token)).length
  return overlap / targetTokens.length
}

function isWeakProbeTarget(target: string, context?: ProbeQuestionContext): boolean {
  if (!target) return true

  const lower = target.toLowerCase()
  if (/^(that|this|it|thing|the question|the answer|the example|the details?|details?|specifics?|more details|the point|the topic)$/i.test(lower)) {
    return true
  }
  if (/^(what|why|how|which|when|where|who)\b/i.test(lower)) {
    return true
  }
  if (/\b(?:tradeoff rationale|rationale|rubric|criterion|criteria|competenc(?:y|ies))\b/i.test(lower)) {
    return true
  }
  if (/\bexact\b/i.test(lower) && /\b(?:partner|partners|kpi|kpis|metric|metrics)\b/i.test(lower)) {
    return true
  }

  const targetTokens = significantTokens(target)
  if (targetTokens.length < 2) return true

  const questionOverlap = overlapRatio(targetTokens, context?.question)
  const answerOverlap = overlapRatio(targetTokens, context?.answer)
  const previousProbeOverlap = overlapRatio(targetTokens, context?.previousProbe)

  if (targetTokens.length >= 3 && questionOverlap >= 0.67 && answerOverlap < 0.5) {
    return true
  }
  if (targetTokens.length >= 3 && previousProbeOverlap >= 0.67) {
    return true
  }

  return false
}

function fallbackProbeQuestion(probeType: ProbeType | null | undefined): string {
  switch (probeType) {
    case 'quantify':
      return 'Can you share the measurable outcome or scale?'
    case 'challenge':
      return 'What trade-off did you consider, and how did you decide?'
    case 'clarify':
      return 'Can you make that more concrete with a specific example?'
    case 'expand':
    default:
      return 'Can you walk me through the specific example?'
  }
}

function targetFromProbeQuestion(question: string): string {
  const normalized = normalizeProbeTarget(question)
  const exactClarify = normalized.match(/^what exactly do you mean by\s+(.+)$/i)
  if (exactClarify?.[1]) return normalizeProbeTarget(exactClarify[1])

  const anchored = normalized.match(
    /(?:about|by|approach|quantify|clarify|walk me through|share)\s+(.+)$/i
  )
  if (anchored?.[1]) return normalizeProbeTarget(anchored[1])

  return normalized
}

export function sanitizeProbeQuestion(
  probeQuestion: string | null | undefined,
  context?: ProbeQuestionContext,
  probeType?: ProbeType | null,
): string | undefined {
  const normalized = normalizeProbeTarget(probeQuestion)
  if (!normalized) return undefined

  const target = targetFromProbeQuestion(normalized)
  if (/^what exactly do you mean by\b/i.test(normalized) || isWeakProbeTarget(target, context)) {
    return fallbackProbeQuestion(probeType)
  }

  return normalized.endsWith('?') ? normalized : `${normalized}?`
}

/**
 * Construct a natural probe question from the evaluator's intent fields.
 * The evaluator provides *what* to probe (probeType + probeTarget);
 * this function provides the conversational *wording*.
 */
export function buildProbeQuestion(
  probeType: ProbeType | null | undefined,
  probeTarget?: string | null,
  context?: ProbeQuestionContext,
): string {
  const t = normalizeProbeTarget(probeTarget)
  if (isWeakProbeTarget(t, context)) {
    return fallbackProbeQuestion(probeType)
  }

  switch (probeType) {
    case 'expand':    return `Can you tell me more about ${t}?`
    case 'clarify':   return `Can you clarify ${t} with a specific example?`
    case 'challenge': return `How did you specifically approach ${t}?`
    case 'quantify':  return `Can you quantify ${t} — what changed measurably?`
    default:          return `Can you elaborate on ${t}?`
  }
}

/**
 * Try to extract a company/employer name from thread text.
 * Looks for patterns like "at CompanyName" or "Company Name" in both
 * interviewer questions and candidate answers.
 */
function extractCompanyFromThread(thread: ThreadEntry[]): string | undefined {
  const allText = thread.map(t => t.text).join(' ')
  // Match "at <Company>" — common interviewer phrasing
  const atMatch = allText.match(/\bat\s+([A-Z][A-Za-z0-9.&\- ]{1,30}?)(?:\s*[,?.!]|\s+(?:and|when|where|how|what|why|your|the|you|during|for|in|as|to)\b)/i)
  if (atMatch?.[1]) {
    const candidate = atMatch[1].trim()
    // Filter out generic words that aren't company names
    const generic = new Set(['the', 'a', 'an', 'your', 'this', 'that', 'one', 'some'])
    if (!generic.has(candidate.toLowerCase()) && candidate.length > 1) {
      return candidate
    }
  }
  return undefined
}

/**
 * Build a summary for a completed conversation thread (topic + probes).
 */
export function buildThreadSummary(
  topicIndex: number,
  topicQuestion: string,
  thread: ThreadEntry[],
  threadEvals: AnswerEvaluation[],
  company?: string,
): ThreadSummary {
  const avgScore = threadEvals.length > 0
    ? threadEvals.reduce((s, e) => s + (e.relevance + e.structure + e.specificity + e.ownership) / 4, 0) / threadEvals.length
    : 0
  const probeEntries = thread.filter(t => t.isProbe && t.role === 'interviewer')
  const probeTypes = Array.from(new Set(probeEntries.map(t => t.probeType).filter(Boolean))) as string[]

  const summary = `Discussed "${topicQuestion}". Avg score: ${Math.round(avgScore)}. ${probeEntries.length > 0 ? `Probed ${probeEntries.length} time(s) (${probeTypes.join(', ')}).` : 'No probing needed.'}`

  // Best-effort company extraction: use explicit param, or try to extract from text
  const resolvedCompany = company || extractCompanyFromThread(thread)

  return {
    topicIndex,
    topicQuestion,
    summary,
    avgScore: Math.round(avgScore),
    probeCount: probeEntries.length,
    probeTypes,
    ...(resolvedCompany ? { company: resolvedCompany } : {}),
  }
}

/**
 * Map a pushback tone to an avatar emotion for visual feedback.
 */
export function toneToEmotion(tone: PushbackTone): AvatarEmotion {
  switch (tone) {
    case 'curious': return 'curious'
    case 'probing': return 'skeptical'
    case 'encouraging': return 'friendly'
  }
}
