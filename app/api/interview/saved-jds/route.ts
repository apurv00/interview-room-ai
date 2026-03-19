import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { connectDB } from '@shared/db/connection'
import { SavedJobDescription } from '@shared/db/models'

export const dynamic = 'force-dynamic'

const SaveJDSchema = z.object({
  name: z.string().min(1).max(200),
  parsedJD: z.object({
    rawText: z.string(),
    company: z.string(),
    role: z.string(),
    inferredDomain: z.string(),
    requirements: z.array(z.object({
      id: z.string(),
      category: z.enum(['technical', 'behavioral', 'experience', 'education', 'cultural']),
      requirement: z.string(),
      importance: z.enum(['must-have', 'nice-to-have']),
      targetCompetencies: z.array(z.string()),
    })),
    keyThemes: z.array(z.string()),
  }),
})

export const POST = composeApiRoute({
  schema: SaveJDSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 20, keyPrefix: 'interview:saved-jds' },
  handler: async (_req: NextRequest, { user, body }) => {
    await connectDB()
    const saved = await SavedJobDescription.create({
      userId: user.id,
      name: body.name,
      parsedJD: body.parsedJD,
    })
    return NextResponse.json({ id: saved._id }, { status: 201 })
  },
})

export const GET = composeApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 30, keyPrefix: 'interview:saved-jds' },
  handler: async (_req: NextRequest, { user }) => {
    await connectDB()
    const jds = await SavedJobDescription.find({ userId: user.id })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean()

    return NextResponse.json(jds.map(jd => ({
      id: jd._id,
      name: jd.name,
      company: jd.parsedJD.company,
      role: jd.parsedJD.role,
      requirementCount: jd.parsedJD.requirements.length,
      createdAt: jd.createdAt,
    })))
  },
})
