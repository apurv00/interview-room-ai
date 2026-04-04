import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { evaluatePhaseTransition, advancePhase } from '@learn/services/dailyPlanService'

/**
 * POST /api/learn/plan/advance-phase
 *
 * Evaluates whether the user is ready to advance to the next phase.
 * If ready, advances automatically and returns the new phase.
 * Called after each interview completion.
 */
export const POST = composeApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 10, keyPrefix: 'rl:advance-phase' },

  async handler(_req, { user }) {
    const evaluation = await evaluatePhaseTransition(user.id)

    if (evaluation.shouldAdvance && evaluation.nextPhase) {
      const advanced = await advancePhase(user.id)
      return NextResponse.json({
        advanced: true,
        previousPhase: evaluation.currentPhase,
        newPhase: evaluation.nextPhase,
        reason: evaluation.reason,
        success: advanced,
      })
    }

    return NextResponse.json({
      advanced: false,
      currentPhase: evaluation.currentPhase,
      reason: evaluation.reason,
    })
  },
})
