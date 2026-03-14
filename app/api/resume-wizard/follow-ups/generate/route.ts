import { NextResponse } from 'next/server'
import { connectDB } from '@shared/db/connection'
import { WizardSession } from '@shared/db/models/WizardSession'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { GenerateFollowUpsSchema } from '@resume/wizard/validators/wizardSchemas'
import { generateFollowUpQuestions } from '@resume/wizard/services/wizardAIService'
import type { GenerateFollowUpsInput } from '@resume/wizard/validators/wizardSchemas'

export const dynamic = 'force-dynamic'

export const POST = composeApiRoute<GenerateFollowUpsInput>({
  schema: GenerateFollowUpsSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 10, keyPrefix: 'rl:wiz-followup' },
  handler: async (_req, { user, body }) => {
    await connectDB()

    const session = await WizardSession.findById(body.sessionId).select('userId segment').lean()
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }
    if (session.userId.toString() !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const result = await generateFollowUpQuestions(user, body.sessionId, {
      jobTitle: body.jobTitle,
      company: body.company,
      rawDescription: body.rawDescription,
      segment: session.segment || 'experienced',
    })

    return NextResponse.json({
      roleId: body.roleId,
      questions: result.questions,
      cost: result.cost,
      model: result.model,
    })
  },
})
