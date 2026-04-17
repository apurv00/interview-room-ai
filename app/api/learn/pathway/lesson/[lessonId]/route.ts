import { NextResponse } from 'next/server'
import mongoose from 'mongoose'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { getOrGenerateLesson } from '@learn/services/lessonGenerator'
import { getUniversalPlan } from '@learn/services/pathwayPlanner'
import { LessonEngagement } from '@shared/db/models/LessonEngagement'
import { connectDB } from '@shared/db/connection'
import { logger } from '@shared/logger'

export const dynamic = 'force-dynamic'

export const GET = composeApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 30, keyPrefix: 'rl:pathway-lesson-get' },
  async handler(req, { user, params }) {
    const lessonId = params.lessonId
    if (!lessonId) {
      return NextResponse.json({ error: 'Missing lessonId' }, { status: 400 })
    }

    const plan = await getUniversalPlan(user.id)
    if (!plan) {
      return NextResponse.json({ error: 'No universal plan' }, { status: 404 })
    }

    const entry = plan.lessons?.find((l) => l.lessonId === lessonId)
    if (!entry) {
      return NextResponse.json({ error: 'Lesson not in plan' }, { status: 404 })
    }

    const url = new URL(req.url)
    const domain = plan.domain ?? url.searchParams.get('domain') ?? 'general'
    const depth = plan.depth ?? url.searchParams.get('depth') ?? 'behavioral'

    const lesson = await getOrGenerateLesson({
      competency: entry.competency,
      domain,
      depth,
    })
    if (!lesson) {
      return NextResponse.json({ error: 'Lesson generation failed' }, { status: 502 })
    }

    await recordEngagement(user.id, lesson._id, entry.competency, domain).catch((err) => {
      logger.warn({ err, userId: user.id, lessonId }, 'LessonEngagement write failed')
    })

    return NextResponse.json({
      lesson: {
        lessonId: entry.lessonId,
        competency: entry.competency,
        title: lesson.title,
        conceptSummary: lesson.conceptSummary,
        conceptDeepDive: lesson.conceptDeepDive,
        example: lesson.example,
        keyTakeaways: lesson.keyTakeaways,
        overrideContent: lesson.overrideContent,
      },
      completed: !!entry.completed,
    })
  },
})

async function recordEngagement(
  userId: string,
  lessonObjectId: mongoose.Types.ObjectId,
  competency: string,
  domain: string,
): Promise<void> {
  await connectDB()
  await LessonEngagement.create({
    userId: new mongoose.Types.ObjectId(userId),
    lessonId: lessonObjectId,
    competency,
    domain,
    openedAt: new Date(),
  })
}
