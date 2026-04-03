import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { DailyChallenge } from '@shared/db/models/DailyChallenge'
import { DailyChallengeAttempt } from '@shared/db/models/DailyChallengeAttempt'
import { QuestionBank } from '@shared/db/models/QuestionBank'
import { User } from '@shared/db/models/User'
import { isFeatureEnabled } from '@shared/featureFlags'
import { aiLogger as logger } from '@shared/logger'
import { getAnthropicClient } from '@shared/services/llmClient'

const DOMAINS_ROTATION = [
  'frontend', 'backend', 'sdet', 'devops', 'data-science',
  'pm', 'design',
  'business', 'marketing', 'finance', 'sales',
]

function getTodayUTC(): string {
  return new Date().toISOString().split('T')[0]
}

/**
 * Get today's challenge. Creates one if it doesn't exist yet.
 */
export async function getTodaysChallenge(): Promise<{
  date: string
  question: string
  domain: string
  difficulty: string
  participantCount: number
  avgScore: number
} | null> {
  if (!isFeatureEnabled('engagement_daily_challenge')) return null

  try {
    await connectDB()
    const today = getTodayUTC()

    let challenge = await DailyChallenge.findOne({ date: today }).lean()

    if (!challenge) {
      challenge = await generateDailyChallenge(today)
    }

    return {
      date: challenge.date,
      question: challenge.question,
      domain: challenge.domain,
      difficulty: challenge.difficulty,
      participantCount: challenge.participantCount,
      avgScore: Math.round(challenge.avgScore),
    }
  } catch (err) {
    logger.error({ err }, 'Failed to get daily challenge')
    return null
  }
}

/**
 * Generate a daily challenge for a given date.
 */
async function generateDailyChallenge(date: string) {
  await connectDB()

  // Pick a domain via round-robin based on the day of year
  const dayOfYear = Math.floor(
    (new Date(date).getTime() - new Date(new Date(date).getFullYear(), 0, 0).getTime()) / (1000 * 60 * 60 * 24)
  )
  const domain = DOMAINS_ROTATION[dayOfYear % DOMAINS_ROTATION.length]

  // Try to find a question from QuestionBank
  const bankQuestion = await QuestionBank.findOne({
    domain,
    isActive: true,
  })
    .skip(Math.floor(Math.random() * 10))
    .lean()
    .catch(() => null)

  if (bankQuestion) {
    const created = await DailyChallenge.create({
      date,
      question: bankQuestion.question,
      domain: bankQuestion.domain,
      interviewType: 'behavioral',
      difficulty: 'medium',
      category: bankQuestion.category || '',
      targetCompetencies: bankQuestion.targetCompetencies || [],
      idealAnswerPoints: bankQuestion.idealAnswerPoints || [],
      commonMistakes: [],
    })
    return created.toObject()
  }

  // Fallback: generate via Claude
  try {
    const client = getAnthropicClient()
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: 'You generate behavioral interview questions. Respond with ONLY valid JSON.',
      messages: [{
        role: 'user',
        content: `Generate a medium-difficulty behavioral interview question for the "${domain}" domain.

Respond as JSON:
{"question": "the question text", "category": "category name", "targetCompetencies": ["comp1", "comp2"], "idealAnswerPoints": ["point1", "point2", "point3"]}`,
      }],
    })

    const raw = message.content[0].type === 'text' ? message.content[0].text.trim() : '{}'
    const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    const parsed = JSON.parse(cleaned)

    const created = await DailyChallenge.create({
      date,
      question: parsed.question || `Tell me about a challenging situation you faced in ${domain} and how you handled it.`,
      domain,
      interviewType: 'behavioral',
      difficulty: 'medium',
      category: parsed.category || 'general',
      targetCompetencies: parsed.targetCompetencies || [],
      idealAnswerPoints: parsed.idealAnswerPoints || [],
      commonMistakes: [],
    })
    return created.toObject()
  } catch {
    // Absolute fallback
    const created = await DailyChallenge.create({
      date,
      question: `Tell me about a time you had to solve a complex problem in a ${domain} context. What was your approach and what was the outcome?`,
      domain,
      interviewType: 'behavioral',
      difficulty: 'medium',
      category: 'problem-solving',
      targetCompetencies: ['problem-solving', 'communication'],
      idealAnswerPoints: ['Clear problem description', 'Structured approach', 'Measurable outcome'],
      commonMistakes: [],
    })
    return created.toObject()
  }
}

/**
 * Submit a daily challenge answer. Scores via Claude AI.
 */
export async function submitChallengeAnswer(
  userId: string,
  date: string,
  answer: string,
): Promise<{
  score: number
  breakdown: { relevance: number; structure: number; specificity: number; ownership: number }
  percentile: number
  communityAvg: number
  participantCount: number
} | null> {
  if (!isFeatureEnabled('engagement_daily_challenge')) return null

  try {
    await connectDB()
    const uid = new mongoose.Types.ObjectId(userId)

    // Check if already submitted
    const existing = await DailyChallengeAttempt.findOne({ userId: uid, challengeDate: date }).lean()
    if (existing) {
      return {
        score: existing.score,
        breakdown: existing.breakdown,
        percentile: existing.percentile || 0,
        communityAvg: 0,
        participantCount: 0,
      }
    }

    // Get the challenge
    const challenge = await DailyChallenge.findOne({ date }).lean()
    if (!challenge) return null

    // Score via Claude
    const client = getAnthropicClient()
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: 'You are an expert interview coach. Score the candidate\'s answer objectively.',
      messages: [{
        role: 'user',
        content: `Score this interview answer on 4 dimensions (0-100 each):

Question: "${challenge.question}"

<candidate_answer>
${answer}
</candidate_answer>

Score on:
- relevance: How directly does the answer address the question?
- structure: Does it follow STAR format (Situation, Task, Action, Result)?
- specificity: Are there concrete examples, metrics, and details?
- ownership: Does the candidate show personal contribution and accountability?

Respond with ONLY valid JSON:
{"relevance": number, "structure": number, "specificity": number, "ownership": number}`,
      }],
    })

    const raw = message.content[0].type === 'text' ? message.content[0].text.trim() : '{}'
    const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    const scores = JSON.parse(cleaned)

    const score = Math.round(
      (scores.relevance + scores.structure + scores.specificity + scores.ownership) / 4
    )

    // Calculate percentile
    const totalAttempts = await DailyChallengeAttempt.countDocuments({ challengeDate: date })
    const belowCount = await DailyChallengeAttempt.countDocuments({ challengeDate: date, score: { $lt: score } })
    const percentile = totalAttempts > 0 ? Math.round((belowCount / totalAttempts) * 100) : 50

    // Save attempt
    await DailyChallengeAttempt.create({
      userId: uid,
      challengeDate: date,
      answer,
      score,
      breakdown: scores,
      percentile,
    })

    // Update challenge stats atomically
    const updatedChallenge = await DailyChallenge.findOneAndUpdate(
      { date },
      {
        $inc: { participantCount: 1 },
      },
      { new: true },
    )

    // Recalculate average
    if (updatedChallenge) {
      const newCount = updatedChallenge.participantCount
      const oldAvg = updatedChallenge.avgScore
      const newAvg = ((oldAvg * (newCount - 1)) + score) / newCount
      await DailyChallenge.updateOne({ date }, { avgScore: newAvg })
    }

    return {
      score,
      breakdown: scores,
      percentile,
      communityAvg: Math.round(updatedChallenge?.avgScore || score),
      participantCount: updatedChallenge?.participantCount || 1,
    }
  } catch (err) {
    logger.error({ err, userId, date }, 'Failed to submit challenge answer')
    return null
  }
}

/**
 * Check if a user has completed today's challenge.
 */
export async function hasUserCompletedToday(userId: string): Promise<boolean> {
  try {
    await connectDB()
    const today = getTodayUTC()
    const attempt = await DailyChallengeAttempt.findOne({
      userId: new mongoose.Types.ObjectId(userId),
      challengeDate: today,
    }).lean()
    return !!attempt
  } catch {
    return false
  }
}

/**
 * Get a user's past challenge attempts.
 */
export async function getUserChallengeHistory(userId: string, limit = 20): Promise<Array<{
  challengeDate: string
  score: number
  breakdown: { relevance: number; structure: number; specificity: number; ownership: number }
  percentile?: number
}>> {
  try {
    await connectDB()
    const attempts = await DailyChallengeAttempt.find({
      userId: new mongoose.Types.ObjectId(userId),
    })
      .sort({ challengeDate: -1 })
      .limit(limit)
      .select('challengeDate score breakdown percentile')
      .lean()

    return attempts.map(a => ({
      challengeDate: a.challengeDate,
      score: a.score,
      breakdown: a.breakdown,
      percentile: a.percentile,
    }))
  } catch (err) {
    logger.error({ err, userId }, 'Failed to get challenge history')
    return []
  }
}

/**
 * Get today's challenge leaderboard.
 */
export async function getChallengeLeaderboard(date?: string, limit = 20): Promise<Array<{
  name: string
  score: number
  rank: number
}>> {
  try {
    await connectDB()
    const targetDate = date || getTodayUTC()

    const attempts = await DailyChallengeAttempt.find({ challengeDate: targetDate })
      .sort({ score: -1 })
      .limit(limit)
      .select('userId score')
      .lean()

    if (attempts.length === 0) return []

    const userIds = attempts.map(a => a.userId)
    const users = await User.find({ _id: { $in: userIds } })
      .select('name')
      .lean()
    const nameMap = new Map(users.map(u => [u._id.toString(), u.name]))

    return attempts.map((a, i) => ({
      name: nameMap.get(a.userId.toString()) || 'Anonymous',
      score: a.score,
      rank: i + 1,
    }))
  } catch (err) {
    logger.error({ err }, 'Failed to get challenge leaderboard')
    return []
  }
}
