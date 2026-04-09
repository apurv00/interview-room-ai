import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { saveDrillAttempt } from '@learn/services/drillService'
import { awardXp } from '@learn/services/xpService'
import { recordActivity, updateStreak } from '@learn/services/streakService'
import { checkAndAwardBadges } from '@learn/services/badgeService'
import { XP_AMOUNTS } from '@learn/config/xpTable'
import { completion } from '@shared/services/modelRouter'
import { aiLogger } from '@shared/logger'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json()
    const { sessionId, questionIndex, question, originalAnswer, originalScore, newAnswer, competency } = body

    if (!question || !newAnswer || !sessionId) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    // Score the new answer using Claude
    const aiResult = await completion({
      taskSlot: 'learn.drill-evaluate',
      system: 'You are an expert interview coach. Score the candidate\'s answer objectively.',
      messages: [{
        role: 'user',
        content: `Score this interview answer on 4 dimensions (0-100 each):

Question: "${question}"

<candidate_answer>
${newAnswer}
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

    const raw = aiResult.text || '{}'
    const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    const scores = JSON.parse(cleaned)

    const newScore = Math.round(
      (scores.relevance + scores.structure + scores.specificity + scores.ownership) / 4
    )

    const result = await saveDrillAttempt(session.user.id, {
      sessionId,
      questionIndex: questionIndex ?? 0,
      question,
      originalAnswer: originalAnswer || '',
      originalScore: originalScore ?? 0,
      newAnswer,
      newScore,
      competency: competency || 'general',
    })

    // Award XP and update streak for drill completion
    await awardXp(session.user.id, 'drill_complete', XP_AMOUNTS.drill_complete, { sessionId, questionIndex })
    await recordActivity(session.user.id)
    const streakResult = await updateStreak(session.user.id)
    await checkAndAwardBadges(session.user.id, {
      type: 'drill_complete',
      score: newScore,
      currentStreak: streakResult.currentStreak,
    })

    return NextResponse.json({
      ...result,
      newScore,
      delta: newScore - (originalScore ?? 0),
      breakdown: scores,
    })
  } catch (err) {
    aiLogger.error({ err }, 'Drill evaluate error')
    return NextResponse.json({ error: 'Evaluation failed' }, { status: 500 })
  }
}
