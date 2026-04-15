import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { SessionSummary } from '@shared/db/models'
import type { ISessionSummary } from '@shared/db/models'
import type { TranscriptEntry, AnswerEvaluation, SpeechMetrics, FeedbackData } from '@shared/types'
import { isFeatureEnabled } from '@shared/featureFlags'
import { logger } from '@shared/logger'

// ─── Generate Session Summary ────────────────────────────────────────────────

interface GenerateSummaryInput {
  userId: string
  sessionId: string
  domain: string
  interviewType: string
  experience: string
  evaluations: AnswerEvaluation[]
  speechMetrics: SpeechMetrics[]
  feedback: FeedbackData
  transcript: TranscriptEntry[]
  durationMinutes: number
}

export async function generateSessionSummary(input: GenerateSummaryInput): Promise<ISessionSummary | null> {
  if (!isFeatureEnabled('session_summaries')) return null

  try {
    await connectDB()

    const {
      userId, sessionId, domain, interviewType, experience,
      evaluations, speechMetrics, feedback, transcript, durationMinutes,
    } = input

    // Extract competency scores from evaluations
    const competencyScores: Record<string, number> = {}
    if (evaluations.length > 0) {
      const dims = ['relevance', 'structure', 'specificity', 'ownership'] as const
      for (const dim of dims) {
        const scores = evaluations.map(e => e[dim]).filter(s => s !== undefined)
        if (scores.length > 0) {
          competencyScores[dim] = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
        }
      }
    }

    // Extract topics covered from questions
    const topicsCovered = extractTopics(transcript)

    // Communication markers
    const avgWpm = speechMetrics.length > 0
      ? Math.round(speechMetrics.reduce((s, m) => s + m.wpm, 0) / speechMetrics.length)
      : 0
    const avgFillerRate = speechMetrics.length > 0
      ? parseFloat((speechMetrics.reduce((s, m) => s + m.fillerRate, 0) / speechMetrics.length).toFixed(3))
      : 0
    const avgRamblingIndex = speechMetrics.length > 0
      ? parseFloat((speechMetrics.reduce((s, m) => s + m.ramblingIndex, 0) / speechMetrics.length).toFixed(2))
      : 0

    // Major mistakes from flags
    const majorMistakes = evaluations
      .flatMap(e => e.flags)
      .filter(Boolean)
      .slice(0, 5)

    const summary = await SessionSummary.findOneAndUpdate(
      { sessionId: new mongoose.Types.ObjectId(sessionId) },
      {
        userId: new mongoose.Types.ObjectId(userId),
        sessionId: new mongoose.Types.ObjectId(sessionId),
        domain,
        interviewType,
        experience,
        // G.5: `??` preserves a legit 0 (abandoned session) distinctly
        // from "field missing". Today both paths write 0, but a future
        // analytics query will need to differentiate "abandoned" from
        // "LLM returned no overall_score".
        overallScore: feedback.overall_score ?? 0,
        passProb: feedback.pass_probability || 'Medium',
        competencyScores,
        strengths: feedback.dimensions?.answer_quality?.strengths?.slice(0, 3) || [],
        weaknesses: feedback.dimensions?.answer_quality?.weaknesses?.slice(0, 3) || [],
        majorMistakes,
        improvements: feedback.top_3_improvements || [],
        topicsCovered,
        communicationMarkers: {
          avgWpm,
          fillerRate: avgFillerRate,
          ramblingIndex: avgRamblingIndex,
          confidenceTrend: feedback.dimensions?.engagement_signals?.confidence_trend || 'stable',
        },
        sessionDate: new Date(),
        durationMinutes,
      },
      { upsert: true, new: true }
    )

    return summary
  } catch (err) {
    logger.error({ err }, 'Failed to generate session summary')
    return null
  }
}

// ─── Get Recent Summaries for Personalization ────────────────────────────────

export async function getRecentSummaries(
  userId: string,
  domain?: string,
  limit = 5
): Promise<Array<{
  overallScore: number
  strengths: string[]
  weaknesses: string[]
  majorMistakes: string[]
  topicsCovered: string[]
  competencyScores: Record<string, number>
  sessionDate: Date
  interviewType: string
}>> {
  if (!isFeatureEnabled('session_summaries')) return []

  try {
    await connectDB()

    const filter: Record<string, unknown> = { userId: new mongoose.Types.ObjectId(userId) }
    if (domain) filter.domain = domain

    const summaries = await SessionSummary.find(filter)
      .sort({ sessionDate: -1 })
      .limit(limit)
      .select('overallScore strengths weaknesses majorMistakes topicsCovered competencyScores sessionDate interviewType')
      .lean()

    return summaries.map(s => ({
      overallScore: s.overallScore,
      strengths: s.strengths,
      weaknesses: s.weaknesses,
      majorMistakes: s.majorMistakes,
      topicsCovered: s.topicsCovered,
      competencyScores: s.competencyScores as Record<string, number>,
      sessionDate: s.sessionDate,
      interviewType: s.interviewType,
    }))
  } catch (err) {
    logger.error({ err }, 'Failed to get recent summaries')
    return []
  }
}

// ─── Build Compact History Summary for Prompt Injection ─────────────────────

export async function buildHistorySummary(userId: string, domain?: string): Promise<string> {
  const summaries = await getRecentSummaries(userId, domain, 3)

  if (summaries.length === 0) return ''

  const lines: string[] = ['Recent session history:']

  for (const s of summaries) {
    const date = s.sessionDate.toISOString().split('T')[0]
    lines.push(`- [${date}] Score: ${s.overallScore}/100 | Type: ${s.interviewType}`)
    if (s.weaknesses.length > 0) {
      lines.push(`  Weaknesses: ${s.weaknesses.join('; ')}`)
    }
    if (s.majorMistakes.length > 0) {
      lines.push(`  Mistakes: ${s.majorMistakes.join('; ')}`)
    }
  }

  // Aggregate topics to avoid
  const allTopics = summaries.flatMap(s => s.topicsCovered)
  const uniqueTopics = Array.from(new Set(allTopics))
  if (uniqueTopics.length > 0) {
    lines.push(`Topics already covered recently: ${uniqueTopics.slice(0, 10).join(', ')}`)
  }

  return lines.join('\n')
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractTopics(transcript: TranscriptEntry[]): string[] {
  // Extract key topics from interviewer questions
  const topics: string[] = []
  const interviewerEntries = transcript.filter(t => t.speaker === 'interviewer')

  for (const entry of interviewerEntries) {
    const text = entry.text.toLowerCase()
    // Extract core topic using keyword patterns
    const topicPatterns = [
      /tell me about (?:a time (?:when )?)?(.+?)(?:\.|$)/,
      /how (?:do|did|would) you (.+?)(?:\?|$)/,
      /describe (?:a|your) (.+?)(?:\.|$)/,
      /what (?:is|was|are) your (.+?)(?:\?|$)/,
      /walk me through (.+?)(?:\.|$)/,
    ]

    for (const pattern of topicPatterns) {
      const match = text.match(pattern)
      if (match?.[1]) {
        const topic = match[1].trim().slice(0, 60)
        if (topic.length > 5) topics.push(topic)
        break
      }
    }
  }

  return Array.from(new Set(topics)).slice(0, 10)
}
