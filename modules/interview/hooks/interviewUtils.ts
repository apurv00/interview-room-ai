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
  if (!probe?.shouldProbe || !probe.probeQuestion) return 'advance'
  if (timeRemaining < 60) return 'advance'
  // Don't probe if we haven't covered minimum topics and are running low on time
  const topicsNeeded = getMinimumTopics(duration) - completedThreadsCount
  const roughTimePerTopic = 90 // ~1.5 min per topic
  if (topicsNeeded > 0 && topicsNeeded * roughTimePerTopic > timeRemaining) return 'advance'
  return 'probe'
}

/**
 * Build a summary for a completed conversation thread (topic + probes).
 */
export function buildThreadSummary(
  topicIndex: number,
  topicQuestion: string,
  thread: ThreadEntry[],
  threadEvals: AnswerEvaluation[],
): ThreadSummary {
  const avgScore = threadEvals.length > 0
    ? threadEvals.reduce((s, e) => s + (e.relevance + e.structure + e.specificity + e.ownership) / 4, 0) / threadEvals.length
    : 0
  const probeEntries = thread.filter(t => t.isProbe && t.role === 'interviewer')
  const probeTypes = Array.from(new Set(probeEntries.map(t => t.probeType).filter(Boolean))) as string[]

  const summary = `Discussed "${topicQuestion}". Avg score: ${Math.round(avgScore)}. ${probeEntries.length > 0 ? `Probed ${probeEntries.length} time(s) (${probeTypes.join(', ')}).` : 'No probing needed.'}`

  return {
    topicIndex,
    topicQuestion,
    summary,
    avgScore: Math.round(avgScore),
    probeCount: probeEntries.length,
    probeTypes,
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
