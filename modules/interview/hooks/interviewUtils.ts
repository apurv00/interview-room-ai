import type {
  AnswerEvaluation,
  AvatarEmotion,
  DesignSubmission,
  PerformanceSignal,
  ProbeType,
  PushbackTone,
  ThreadEntry,
  ThreadSummary,
  TranscriptEntry,
} from '@shared/types'
import type { Duration } from '@shared/types'
import { getMinimumTopics } from '@interview/config/interviewConfig'

/**
 * The previousQA window sent to generate-question. Normally the last 10 transcript entries
 * (older topics are summarized in completedThreads). For ACADEMICS the candidate names their
 * subject in the FIRST answer (the intro), and that subject must stay in the prompt for the
 * whole round — but it would fall out of the last-10 window after a few topics. So we PIN the
 * intro Q&A to the front. Without it, the subject-grounding directive loses the named subject
 * mid-round and the round drifts back to the skill's illustrative sample subjects (PR #469).
 */
export function buildPreviousQA(transcript: TranscriptEntry[], interviewType?: string): TranscriptEntry[] {
  const recent = transcript.slice(-10)
  // Only pin once the intro (index 0-1) has actually dropped out of the last-10 window.
  if (interviewType === 'academics' && transcript.length > 11) {
    return [...transcript.slice(0, 2), ...recent]
  }
  return recent
}

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
 * A "non-answer": the candidate gave essentially nothing usable — didn't know, deflected, or
 * said a few empty words ("It's mash law", "Second question, Again, question"). Scored near-zero
 * across every dimension. Re-probing a non-answer almost never helps, so the orchestrator
 * ADVANCES to a fresh topic instead of grinding the dead one (and wraps up if non-answers
 * persist — see countTrailingNonAnswers). A failed eval (server error, not the candidate's
 * fault) is NOT a non-answer. Depth-agnostic — applies to every interview type.
 */
export function isNonAnswer(evaluation: AnswerEvaluation): boolean {
  if (evaluation.status === 'failed') return false
  const avg = (evaluation.relevance + evaluation.structure + evaluation.specificity + evaluation.ownership) / 4
  // avg < 12 (on the 0-100 dims) is well below even a weak-but-real answer; the specificity
  // floor guards against a fluent-but-empty answer scoring some relevance with zero substance.
  return avg < 12 && evaluation.specificity < 10
}

/**
 * How many of the MOST RECENT evaluations were non-answers, counted consecutively from the end.
 * Used to wrap up gracefully when a candidate has disengaged (several non-answers in a row)
 * rather than dragging them through every remaining planned question.
 *
 * NOTE: evaluations are appended in EVAL-COMPLETION order, not answer order — the main answer's
 * eval runs in the background and can land after the synchronous probe evals. `questionIndex`
 * increments per main question AND per probe, so we sort by it first to recover true chronological
 * order before counting the trailing streak (otherwise a late main eval could break the streak).
 */
export function countTrailingNonAnswers(evals: AnswerEvaluation[]): number {
  const ordered = [...evals].sort((a, b) => (a.questionIndex ?? 0) - (b.questionIndex ?? 0))
  let n = 0
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (isNonAnswer(ordered[i])) n++
    else break
  }
  return n
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
  // A scored non-answer won't improve by re-probing — advance to a fresh topic instead of
  // grinding the dead one (the bound that was missing: only length<5 was caught server-side).
  if (isNonAnswer(evaluation)) return 'advance'
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

  const targetTokens = significantTokens(target)
  if (targetTokens.length < 2) return true

  // A BARE interrogative ("what", "why", "how come") is a weak target — but a full interrogative
  // QUESTION ("how does motivation differ from a need?") is a perfectly good probe. sanitizeProbeQuestion
  // feeds this the WHOLE turn-router question (not a noun phrase), so rejecting EVERY how/why/what-prefixed
  // string stripped well-formed grounded probes down to the generic "specific example" fallback in prod
  // (confirmed against live academics transcripts). Only reject SHORT interrogative fragments.
  if (targetTokens.length <= 3 && /^(what|why|how|which|when|where|who)\b/i.test(lower)) {
    return true
  }
  if (/\b(?:tradeoff rationale|rationale|rubric|criterion|criteria|competenc(?:y|ies))\b/i.test(lower)) {
    return true
  }
  if (/\bexact\b/i.test(lower) && /\b(?:partner|partners|kpi|kpis|metric|metrics)\b/i.test(lower)) {
    return true
  }

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

/**
 * Resolver-or-buffer gate for system-design submissions.
 *
 * In the system-design flow the candidate can click Submit during the
 * pre-canvas scoping window — before `waitForDesignSubmission()` has installed
 * a resolver. Without buffering, that early submission is dropped on the floor
 * and the later wait blocks forever, leaving the interview stuck until the
 * candidate submits a second time. This gate buffers the most recent early
 * submission so the wait resolves with it instead of hanging.
 */
export interface DesignSubmissionGate {
  /** UI Submit handler: resolves an active waiter, else buffers the latest. */
  submit(data: DesignSubmission): void
  /** Return (and clear) a buffered early submission, or null if none. */
  takePending(): DesignSubmission | null
  /** Install the resolver to be invoked by the next `submit`. */
  setResolver(resolve: (data: DesignSubmission) => void): void
  /** Drop any installed resolver and buffered submission (reset between runs). */
  clear(): void
}

export function createDesignSubmissionGate(): DesignSubmissionGate {
  let resolver: ((data: DesignSubmission) => void) | null = null
  let pending: DesignSubmission | null = null
  return {
    submit(data) {
      if (resolver) {
        const resolve = resolver
        resolver = null
        resolve(data)
      } else {
        pending = data
      }
    },
    takePending() {
      const buffered = pending
      pending = null
      return buffered
    },
    setResolver(resolve) {
      resolver = resolve
    },
    clear() {
      resolver = null
      pending = null
    },
  }
}
