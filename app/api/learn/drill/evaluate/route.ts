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
import { JSON_OUTPUT_RULE } from '@shared/services/promptSecurity'

export const dynamic = 'force-dynamic'

/**
 * Wave 5 — type-guard on the LLM `scores` payload before we persist
 * it into `DrillAttempt.breakdown`. Must validate THREE things, not
 * just typeof:
 *
 *   1. Each field IS a number — typeof check
 *   2. Each field is FINITE — `typeof NaN === 'number'` and
 *      `typeof Infinity === 'number'` both slip past a naive typeof
 *      check (Codex P1 on PR #388)
 *   3. Each field is in the 0-100 range that the schema's
 *      `min: 0, max: 100` validators enforce on the subdoc
 *
 * Without (2) and (3) the breakdown could pass the guard, fail
 * Mongoose validation on `create`, and 500 the entire evaluate
 * response — contradicting the comment at the call site that
 * promises "skip the field so the save still succeeds with the
 * avg-only delta as a fallback".
 *
 * On out-of-range or non-finite drift we drop `breakdown` entirely;
 * the avg `newScore` path remains intact. This is honest degradation:
 * an LLM that returned 105 or NaN is noisy enough that we shouldn't
 * pretend the per-dim breakdown is meaningful.
 */
function isFourDimScore(s: unknown): s is {
  relevance: number
  structure: number
  specificity: number
  ownership: number
} {
  if (!s || typeof s !== 'object') return false
  const r = s as Record<string, unknown>
  return (
    isValidDimScore(r.relevance) &&
    isValidDimScore(r.structure) &&
    isValidDimScore(r.specificity) &&
    isValidDimScore(r.ownership)
  )
}

function isValidDimScore(v: unknown): v is number {
  // `Number.isFinite` returns false for NaN, Infinity, -Infinity, and
  // any non-number — strictly tighter than `typeof v === 'number'`.
  // The 0-100 bounds mirror the DrillAttempt.breakdown subdoc schema
  // (min: 0, max: 100) so the route's "skip on bad data" intent
  // matches what Mongoose will accept.
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100
}

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

${JSON_OUTPUT_RULE}
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
      // Wave 5 — persist per-dim breakdown the LLM just computed
      // instead of throwing it away after the avg rolled into
      // `newScore`. Guarded against malformed LLM output: if any
      // dimension is missing or non-numeric, skip the field so the
      // save still succeeds with the avg-only delta as a fallback.
      ...(isFourDimScore(scores) && { breakdown: scores }),
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
