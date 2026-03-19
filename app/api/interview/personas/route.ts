import { NextRequest, NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { connectDB } from '@shared/db/connection'
import { InterviewerPersona } from '@shared/db/models'

export const dynamic = 'force-dynamic'

export const GET = composeApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 30, keyPrefix: 'interview:personas' },
  authOptional: true,
  handler: async (_req: NextRequest) => {
    await connectDB()
    const personas = await InterviewerPersona.find({ isActive: true })
      .sort({ sortOrder: 1 })
      .lean()

    return NextResponse.json(personas.map(p => ({
      slug: p.slug,
      name: p.name,
      title: p.title,
      companyArchetype: p.companyArchetype,
      avatarVariant: p.avatarVariant,
      communicationStyle: p.communicationStyle,
      ttsConfig: p.ttsConfig,
      preferredEmotions: p.preferredEmotions,
      isDefault: p.isDefault,
    })))
  },
})
