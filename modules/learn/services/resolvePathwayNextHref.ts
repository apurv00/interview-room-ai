import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models'
import { getCurrentPathway } from './pathwayPlanner'
import { getUserCompetencySummary } from './competencyService'
import { buildPathwayViewModel } from './pathwayViewModel'

/**
 * Universal entry point used when a user has no resolvable pathway action
 * (brand-new users) or when resolution fails. Public-safe and always valid.
 */
export const DEFAULT_NEXT_HREF = '/interview/setup'

/**
 * Server-side resolver for "where should this user's primary CTA go next?".
 *
 * This is the click-time counterpart to the heavy `/api/learn/pathway` GET.
 * The homepage hero CTA used to BLOCK on that endpoint (full view model +
 * ~6 Mongo queries) just to read `nextAction.href`, leaving the button
 * stuck on "Loading your next step…" on cold serverless starts. Here we
 * compute only what `nextAction.href` actually depends on — the current
 * pathway, the competency summary (drives plan state), and the last
 * completed session (drives the no-plan branch) — and reuse the canonical
 * `buildPathwayViewModel` so the destination logic never diverges from the
 * pathway page / banner.
 *
 * `priorPlans` / `competencyStates` are intentionally omitted: they only
 * feed momentum/recurrence insight cards, which `resolveState` and
 * `resolveNextAction` never read. Skipping them drops two Mongo queries.
 *
 * Always resolves to a usable href; never throws.
 */
export async function resolvePathwayNextHref(userId: string): Promise<string> {
  try {
    const [pathway, competencySummary] = await Promise.all([
      getCurrentPathway(userId),
      getUserCompetencySummary(userId),
    ])

    // Last completed session feeds the "no plan yet" branch (baseline vs
    // retry-from-last-session). Isolated + best-effort: a hiccup here just
    // degrades to the baseline branch, never blocks the redirect.
    let lastSessionAt: Date | null = null
    let lastSessionId: string | null = null
    let lastSessionPathwayStatus: string | null = null
    try {
      await connectDB()
      const last = await InterviewSession.findOne({
        userId: new mongoose.Types.ObjectId(userId),
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
      lastSessionAt = last?.completedAt ?? null
      lastSessionId = last?._id?.toString() ?? null
      lastSessionPathwayStatus = last?.pathwayGenerationStatus ?? null
    } catch {
      // Additive lookup — fall through to the no-last-session branch.
    }

    const viewModel = buildPathwayViewModel({
      pathway,
      competencySummary,
      weaknesses: [],
      fromFeedback: null,
      feedbackSessionStatus: null,
      feedbackSessionError: null,
      lastSessionAt,
      lastSessionId,
      lastSessionPathwayStatus,
      pathwayUpdate: null,
    })

    return viewModel.nextAction?.href ?? DEFAULT_NEXT_HREF
  } catch {
    return DEFAULT_NEXT_HREF
  }
}
