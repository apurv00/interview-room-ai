import mongoose from 'mongoose'
import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { connectDB } from '@shared/db/connection'
import { InterviewSession, PathwayPlan, UserCompetencyState } from '@shared/db/models'
import { getCurrentPathway, markTaskComplete } from '@learn/services/pathwayPlanner'
import { getUserCompetencySummary, getUserWeaknesses } from '@learn/services/competencyService'
import { buildPathwayViewModel } from '@learn/services/pathwayViewModel'
import { getPathwayUpdateEligibility } from '@learn/services/pathwayUpdateEligibility'
import { isFeatureEnabled } from '@shared/featureFlags'
import { z } from 'zod'

/**
 * Pathway P2 Wave 3 — how many prior pathway plans we scan to compute
 * recurrence counts. Three plans is enough to distinguish a one-off
 * (count 0) from a persistent blocker (count 1-2) without dragging in
 * ancient history that's no longer meaningful.
 */
const RECURRENCE_PLAN_WINDOW = 3
const STALE_PATHWAY_PENDING_MS = 10 * 60 * 1000

export const dynamic = 'force-dynamic'

function isStalePathwayGeneration(
  status: string | undefined,
  completedAt?: Date | string | null,
  startedAt?: Date | string | null,
): boolean {
  const cutoff = Date.now() - STALE_PATHWAY_PENDING_MS
  if (status === 'pending' && completedAt) {
    return new Date(completedAt).getTime() <= cutoff
  }
  if (status === 'running' && startedAt) {
    return new Date(startedAt).getTime() <= cutoff
  }
  return false
}

// GET: Retrieve current pathway plan and competency summary
export const GET = composeApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 20, keyPrefix: 'rl:pathway' },

  async handler(req, { user }) {
    const { searchParams } = new URL(req.url)
    const fromFeedback = searchParams.get('fromFeedback')

    // Resolve the upstream session's pathway-generation status when the
    // caller arrived from feedback. This lets the view model distinguish
    // "still running" (banner) from "failed after retries" (retry CTA)
    // — Bug B fix. Defensive try/catch so a bad sessionId or DB hiccup
    // never blocks the pathway page itself.
    let feedbackSessionStatus: string | null = null
    let feedbackSessionError: string | null = null
    let pathwayUpdate = null as ReturnType<typeof getPathwayUpdateEligibility> | null
    if (fromFeedback) {
      try {
        await connectDB()
        if (mongoose.isValidObjectId(fromFeedback)) {
          const sess = await InterviewSession.findOne({
            _id: fromFeedback,
            userId: new mongoose.Types.ObjectId(user.id),
          })
            .select(
              'pathwayGenerationStatus pathwayGenerationError pathwayGenerationStartedAt completedAt answeredCount feedback evaluations',
            )
            .lean<{
              pathwayGenerationStatus?: string
              pathwayGenerationError?: string
              pathwayGenerationStartedAt?: Date
              completedAt?: Date
              answeredCount?: number
              feedback?: {
                overall_score?: number | null
                degraded?: boolean
                red_flags?: string[] | null
              } | null
              evaluations?: unknown[]
            }>()
          const rawStatus = sess?.pathwayGenerationStatus
          const stale = isStalePathwayGeneration(
            rawStatus,
            sess?.completedAt,
            sess?.pathwayGenerationStartedAt,
          )
          feedbackSessionStatus = stale ? 'failed' : rawStatus ?? null
          feedbackSessionError = stale
            ? sess?.pathwayGenerationError ??
              'Pathway generation did not start or finish within the expected window.'
            : sess?.pathwayGenerationError ?? null

          pathwayUpdate = getPathwayUpdateEligibility({
            answeredCount: sess?.answeredCount ?? sess?.evaluations?.length ?? 0,
            pathwayPlannerEnabled: isFeatureEnabled('pathway_planner'),
            feedback: sess?.feedback ?? null,
            pathwayGenerationStatus: feedbackSessionStatus,
            evaluationCount: sess?.evaluations?.length ?? 0,
          })
        }
      } catch {
        // Swallow — status lookup is informational only.
      }
    }

    // Pathway P2 Wave 4 — most-recent completed session timestamp,
    // used to derive ActivityRhythm.decayProfile.
    //
    // Codex P1 on PR #383 — this MUST stay isolated from the main
    // payload. The previous shape had `await connectDB()` + a raw
    // `InterviewSession.findOne` inside `Promise.all`, so a Mongo
    // hiccup (or `connectDB` throwing on env/connection issues)
    // rejected the entire handler and returned 500. But the existing
    // service helpers (`getCurrentPathway` / `getUserCompetencySummary`
    // / `getUserWeaknesses`) each have internal try/catches that
    // return null/empty on error, so the handler used to degrade
    // gracefully. Activity rhythm is purely additive UI context
    // (DecayContextCard renders nothing when `lastSessionAt` is null);
    // it should never take down the page.
    //
    // Fix: isolate connect + query in a try/catch with a `null` fallback,
    // matching the Wave 3 priors/states block below.
    const [pathway, competencySummary, weaknesses] = await Promise.all([
      getCurrentPathway(user.id),
      getUserCompetencySummary(user.id),
      getUserWeaknesses(user.id, 10),
    ])

    let lastSessionAt: Date | null = null
    // 2026-05-20 user-reported regression: when a user has completed
    // interviews but no PathwayPlan was ever generated (LLM timeouts,
    // outer-catch on generate-feedback, etc.), the empty-state used
    // to say "Take your first interview" — misleading and frustrating
    // because the user HAS taken interviews. Pulling lastSessionId +
    // pathwayGenerationStatus lets the viewModel surface an actionable
    // CTA ("Pathway didn't generate from your last interview — retry")
    // instead of pretending no interviews exist.
    let lastSessionId: string | null = null
    let lastSessionPathwayStatus: string | null = null
    try {
      await connectDB()
      const lastSessionDoc = await InterviewSession.findOne({
        userId: new mongoose.Types.ObjectId(user.id),
        status: 'completed',
        completedAt: { $exists: true, $ne: null },
      })
        .select({ completedAt: 1, pathwayGenerationStatus: 1 })
        .sort({ completedAt: -1 })
        .lean<{
          _id: mongoose.Types.ObjectId
          completedAt?: Date
          pathwayGenerationStatus?: string
        }>()
      lastSessionAt = lastSessionDoc?.completedAt ?? null
      lastSessionId = lastSessionDoc?._id.toString() ?? null
      lastSessionPathwayStatus = lastSessionDoc?.pathwayGenerationStatus ?? null
    } catch {
      // Swallow — activity-rhythm lookup is additive UI context, never
      // a payload blocker. Card renders nothing when lastSessionAt is null.
    }

    // Pathway P2 Wave 3 — fetch the data the view model needs to
    // populate per-blocker insights (#2 momentum + #8 recurrence).
    // Both queries are bounded (3 prior plans, only the competency
    // states matching current blockers) so the payload stays small.
    // We run these AFTER the main fetch because they depend on the
    // current plan's blocker list — paralellizing pre-fetch isn't
    // worth the wasted query when there's no plan yet.
    const blockerCompetencies = (pathway?.topBlockingWeaknesses ?? []).map((b) => b.competency)
    let priorPlans: Array<{ topBlockingWeaknesses: Array<{ competency: string }> }> = []
    let competencyStates: Array<{
      competencyName: string
      scoreHistory: Array<{ score: number; timestamp: Date }>
    }> = []

    if (pathway) {
      try {
        await connectDB()
        const userObjId = new mongoose.Types.ObjectId(user.id)
        const [priors, states] = await Promise.all([
          PathwayPlan.find({ userId: userObjId, _id: { $ne: pathway._id } })
            .sort({ generatedAt: -1 })
            .limit(RECURRENCE_PLAN_WINDOW)
            .select({ topBlockingWeaknesses: 1 })
            .lean<Array<{ topBlockingWeaknesses?: Array<{ competency: string }> }>>(),
          blockerCompetencies.length > 0
            ? UserCompetencyState.find({
                userId: userObjId,
                competencyName: { $in: blockerCompetencies },
              })
                .select({ competencyName: 1, scoreHistory: 1 })
                .lean<Array<{
                  competencyName: string
                  scoreHistory?: Array<{ score: number; timestamp: Date }>
                }>>()
            : Promise.resolve([]),
        ])
        priorPlans = priors.map((p) => ({
          topBlockingWeaknesses: p.topBlockingWeaknesses ?? [],
        }))
        competencyStates = states.map((s) => ({
          competencyName: s.competencyName,
          scoreHistory: s.scoreHistory ?? [],
        }))
      } catch {
        // Insights are additive — degrade silently so a bad query never
        // breaks the main pathway page render.
      }
    }

    const viewModel = buildPathwayViewModel({
      pathway,
      competencySummary,
      weaknesses,
      fromFeedback,
      feedbackSessionStatus,
      feedbackSessionError,
      priorPlans,
      competencyStates,
      lastSessionAt,
      lastSessionId,
      lastSessionPathwayStatus,
      pathwayUpdate,
    })

    return NextResponse.json({
      ...viewModel,
      pathway,
      competencySummary,
      weaknesses,
    })
  },
})

// PATCH: Mark a practice task as complete
const PatchSchema = z.object({
  action: z.literal('complete_task'),
  taskId: z.string().min(1),
})

export const PATCH = composeApiRoute<z.infer<typeof PatchSchema>>({
  schema: PatchSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 20, keyPrefix: 'rl:pathway-patch' },

  async handler(req, { user, body }) {
    const success = await markTaskComplete(user.id, body.taskId)

    if (!success) {
      return NextResponse.json(
        { error: 'Task not found or already completed' },
        { status: 404 }
      )
    }

    return NextResponse.json({ success: true })
  },
})
