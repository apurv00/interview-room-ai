import type {
  AnswerEvaluation,
  AvatarEmotion,
  PerformanceSignal,
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
  if (evals.length < 2) return 'calibrating'
  const avg = evals.reduce((sum, e) =>
    sum + (e.relevance + e.structure + e.specificity + e.ownership) / 4, 0
  ) / evals.length
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

/**
 * Construct a natural probe question from the evaluator's intent fields.
 * The evaluator provides *what* to probe (probeType + probeTarget);
 * this function provides the conversational *wording*.
 */
export function buildProbeQuestion(
  probeType: import('@shared/types').ProbeType | null | undefined,
  probeTarget?: string | null,
): string {
  const t = probeTarget?.trim() || 'that'
  switch (probeType) {
    case 'expand':    return `Can you tell me more about ${t}?`
    case 'clarify':   return `What exactly do you mean by ${t}?`
    case 'challenge': return `How did you specifically approach ${t}?`
    case 'quantify':  return `Can you put a number on ${t} — what was the measurable outcome?`
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
