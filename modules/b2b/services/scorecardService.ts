import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { InterviewSession, User } from '@shared/db/models'
import { UserCompetencyState } from '@shared/db/models/UserCompetencyState'
import { getAnthropicClient } from '@shared/services/llmClient'
import { logger } from '@shared/logger'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RecruiterScorecard {
  // Basic info
  domain: string
  interviewType: string
  experience: string
  overallScore: number
  passProb: string
  createdAt: string
  durationSeconds: number

  // Dimension breakdown
  dimensions: {
    answerQuality: number
    communication: number
    engagement: number
  }

  // Per-question summary
  questionSummaries: Array<{
    questionIndex: number
    question: string
    score: number
    strengths: string[]
    weaknesses: string[]
  }>

  // Competency radar data
  competencyScores: Array<{
    name: string
    score: number
    trend: string
  }>

  // Key quotes from the interview
  keyQuotes: Array<{
    text: string
    context: string
    sentiment: 'positive' | 'neutral' | 'negative'
  }>

  // AI-generated recruiter summary
  recruiterSummary: string
  strengths: string[]
  improvements: string[]
  redFlags: string[]
}

// ─── Generate Recruiter Scorecard ─────────────────────────────────────────────

export async function getRecruiterScorecard(
  sessionId: string,
  organizationId: string
): Promise<RecruiterScorecard | null> {
  try {
    await connectDB()

    const session = await InterviewSession.findOne({
      _id: new mongoose.Types.ObjectId(sessionId),
      organizationId: new mongoose.Types.ObjectId(organizationId),
      status: 'completed',
    }).lean()

    if (!session?.feedback) return null

    const fb = session.feedback
    const evaluations = session.evaluations || []

    // Build per-question summaries
    const questionSummaries = (evaluations as unknown as Array<Record<string, unknown>>).map((ev, idx) => {
      const avgScore = (
        ((ev.relevance as number) || 0) +
        ((ev.structure as number) || 0) +
        ((ev.specificity as number) || 0) +
        ((ev.ownership as number) || 0)
      ) / 4

      return {
        questionIndex: idx,
        question: (ev.question as string) || `Question ${idx + 1}`,
        score: Math.round(avgScore),
        strengths: [] as string[],
        weaknesses: ((ev.flags as string[]) || []).slice(0, 2),
      }
    })

    // Fetch competency data for the candidate
    let competencyScores: Array<{ name: string; score: number; trend: string }> = []
    if (session.userId) {
      const competencies = await UserCompetencyState.find({
        userId: session.userId,
        domain: session.config?.role,
      }).select('competencyName currentScore trend').lean()

      competencyScores = competencies.map(c => ({
        name: c.competencyName,
        score: Math.round(c.currentScore),
        trend: c.trend,
      }))
    }

    // Extract key quotes from transcript
    const keyQuotes = extractKeyQuotes(
      session.transcript || [],
      evaluations as unknown as Array<Record<string, unknown>>
    )

    // Generate recruiter summary
    const recruiterSummary = await generateRecruiterSummary(
      session.config?.role || '',
      fb.overall_score,
      fb.dimensions?.answer_quality?.strengths || [],
      fb.dimensions?.answer_quality?.weaknesses || [],
      fb.red_flags || []
    )

    return {
      domain: session.config?.role || 'General',
      interviewType: session.config?.interviewType || 'screening',
      experience: session.config?.experience || '0-2',
      overallScore: fb.overall_score || 0,
      passProb: fb.pass_probability || 'Low',
      createdAt: session.createdAt.toISOString(),
      durationSeconds: session.durationActualSeconds || 0,
      dimensions: {
        answerQuality: fb.dimensions?.answer_quality?.score || 0,
        communication: fb.dimensions?.communication?.score || 0,
        engagement: fb.dimensions?.engagement_signals?.score || 0,
      },
      questionSummaries,
      competencyScores,
      keyQuotes,
      recruiterSummary,
      strengths: (fb.dimensions?.answer_quality?.strengths || []).slice(0, 5),
      improvements: (fb.top_3_improvements || []).slice(0, 3),
      redFlags: (fb.red_flags || []).slice(0, 5),
    }
  } catch (err) {
    logger.error({ err }, 'Failed to get recruiter scorecard')
    return null
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractKeyQuotes(
  transcript: Array<{ speaker: string; text: string; questionIndex?: number | null }>,
  evaluations: Array<Record<string, unknown>>
): Array<{ text: string; context: string; sentiment: 'positive' | 'neutral' | 'negative' }> {
  const quotes: Array<{ text: string; context: string; sentiment: 'positive' | 'neutral' | 'negative' }> = []

  // Find the best and worst scored answers
  const scoredAnswers = evaluations
    .map((ev, idx) => ({
      idx,
      score: (((ev.relevance as number) || 0) + ((ev.structure as number) || 0) + ((ev.specificity as number) || 0) + ((ev.ownership as number) || 0)) / 4,
      question: (ev.question as string) || '',
    }))
    .sort((a, b) => b.score - a.score)

  // Best answer quote
  if (scoredAnswers.length > 0) {
    const best = scoredAnswers[0]
    const answer = transcript.find(t => t.speaker === 'candidate' && t.questionIndex === best.idx)
    if (answer) {
      quotes.push({
        text: answer.text.slice(0, 200) + (answer.text.length > 200 ? '...' : ''),
        context: `Strong answer to: "${best.question.slice(0, 80)}"`,
        sentiment: 'positive',
      })
    }
  }

  // Weakest answer quote
  if (scoredAnswers.length > 1) {
    const worst = scoredAnswers[scoredAnswers.length - 1]
    if (worst.score < 55) {
      const answer = transcript.find(t => t.speaker === 'candidate' && t.questionIndex === worst.idx)
      if (answer) {
        quotes.push({
          text: answer.text.slice(0, 200) + (answer.text.length > 200 ? '...' : ''),
          context: `Area for improvement: "${worst.question.slice(0, 80)}"`,
          sentiment: 'negative',
        })
      }
    }
  }

  return quotes
}

async function generateRecruiterSummary(
  domain: string,
  overallScore: number,
  strengths: string[],
  weaknesses: string[],
  redFlags: string[]
): Promise<string> {
  try {
    const client = getAnthropicClient()
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: 'You are a hiring manager writing a brief candidate assessment. Write 2-3 sentences summarizing the candidate\'s interview performance. Be professional and objective.',
      messages: [{
        role: 'user',
        content: `Domain: ${domain}\nScore: ${overallScore}/100\nStrengths: ${strengths.join(', ')}\nWeaknesses: ${weaknesses.join(', ')}\nRed flags: ${redFlags.join(', ') || 'None'}`,
      }],
    })
    return message.content[0].type === 'text' ? message.content[0].text.trim() : ''
  } catch {
    return `Candidate scored ${overallScore}/100 in ${domain} interview.`
  }
}
