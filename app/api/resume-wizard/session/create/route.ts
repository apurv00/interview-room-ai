import { NextResponse } from 'next/server'
import { connectDB } from '@shared/db/connection'
import { WizardSession } from '@shared/db/models/WizardSession'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { CreateWizardSessionSchema } from '@resume/wizard/validators/wizardSchemas'
import type { CreateWizardSessionInput } from '@resume/wizard/validators/wizardSchemas'

export const dynamic = 'force-dynamic'

export const POST = composeApiRoute<CreateWizardSessionInput>({
  schema: CreateWizardSessionSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 5, keyPrefix: 'rl:wiz-create' },
  handler: async (_req, { user, body }) => {
    await connectDB()

    const session = await WizardSession.create({
      userId: user.id,
      segment: body.segment,
      currentStage: 1, // Move past segment selection since they just chose one
      status: 'in_progress',
    })

    return NextResponse.json({
      sessionId: session._id.toString(),
      segment: session.segment,
      currentStage: session.currentStage,
      strengthScore: 0,
      createdAt: session.createdAt,
    })
  },
})
