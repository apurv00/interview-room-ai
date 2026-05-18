import { NextRequest, NextResponse } from 'next/server'
import mongoose from 'mongoose'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { PathwayPlan } from '@shared/db/models'
import { logger } from '@shared/logger'

export const dynamic = 'force-dynamic'

/**
 * GET /api/learn/drill/context/pathway?taskId=<id>
 *
 * Returns the description of the pathway task that originally seeded
 * the drill URL, so `PathwayEntryStrip` can render "From your pathway:
 * {task.description}" at the top of the drill page.
 *
 * Pathway P2 Wave 5 (feature 5A). The Drill page is the only consumer
 * of `buildDrillHref` (`pathwayViewModel.ts`), which passes
 * `task.taskId` as the URL's `actionId` param — that's why this
 * endpoint takes `taskId` directly: the drill page receives `actionId`
 * but already knows it's a taskId in this single calling context.
 *
 * Degradation: returns 404 (not 500) when the user's current plan
 * doesn't contain the task. This is EXPECTED when the Inngest
 * pathway-regen job has replaced `practiceTasks[]` between the URL
 * being minted (on the Pathway page render) and the drill page
 * loading. The strip silently hides on 404 — the drill itself is
 * still valid even when the pathway context is stale.
 *
 * Auth: standard session-based + scopes the plan lookup to the
 * authenticated user. There's no per-task ownership check because
 * tasks live inside the user's own plan document — the document
 * filter already enforces it.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(req.url)
    const taskId = searchParams.get('taskId')?.trim()
    if (!taskId) {
      return NextResponse.json({ error: 'taskId is required' }, { status: 400 })
    }

    await connectDB()

    // Look up the most recent pathway plan for this user. Both
    // "standard" and "universal" plans carry practiceTasks; we accept
    // either so the drill strip works regardless of plan type.
    const plan = await PathwayPlan.findOne({
      userId: new mongoose.Types.ObjectId(session.user.id),
    })
      .sort({ generatedAt: -1 })
      .select({ practiceTasks: 1 })
      .lean<{ practiceTasks?: Array<{ taskId: string; description: string; title?: string }> }>()

    const task = (plan?.practiceTasks ?? []).find((t) => t.taskId === taskId)
    if (!task) {
      // Expected when Inngest regen replaced the task list since the
      // drill URL was minted. Strip hides on 404.
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    return NextResponse.json({
      taskId: task.taskId,
      title: task.title ?? null,
      description: task.description,
    })
  } catch (err) {
    logger.error({ err }, 'Failed to load drill pathway context')
    return NextResponse.json({ error: 'Failed to load' }, { status: 500 })
  }
}
