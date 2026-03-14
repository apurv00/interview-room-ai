import { NextResponse } from 'next/server'
import { connectDB } from '@shared/db/connection'
import { WizardSession } from '@shared/db/models/WizardSession'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { EnhanceWizardSchema } from '@resume/wizard/validators/wizardSchemas'
import { enhanceAllBullets } from '@resume/wizard/services/wizardAIService'
import type { EnhanceWizardInput } from '@resume/wizard/validators/wizardSchemas'

export const dynamic = 'force-dynamic'

export const POST = composeApiRoute<EnhanceWizardInput>({
  schema: EnhanceWizardSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 5, keyPrefix: 'rl:wiz-enhance' },
  handler: async (_req, { user, body }) => {
    await connectDB()

    const session = await WizardSession.findById(body.sessionId)
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }
    if (session.userId.toString() !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const roles = session.roles.map(r => ({
      id: r.id,
      title: r.title,
      company: r.company,
      rawBullets: r.rawBullets,
      followUpQuestions: r.followUpQuestions,
    }))

    const result = await enhanceAllBullets(
      user,
      body.sessionId,
      roles,
      session.segment || 'experienced'
    )

    // Store enhanced bullets in session
    for (const enhanced of result.enhancedRoles) {
      const role = session.roles.find(r => r.id === enhanced.roleId)
      if (role) {
        role.enhancedBullets = enhanced.enhanced
      }
    }
    session.generatedSummary = result.summary
    await session.save()

    return NextResponse.json({
      enhancedRoles: result.enhancedRoles,
      summary: result.summary,
      cost: result.cost,
      model: result.model,
      totalCost: session.aiCostUsd,
    })
  },
})
