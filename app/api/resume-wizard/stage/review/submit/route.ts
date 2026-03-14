import { NextResponse } from 'next/server'
import { connectDB } from '@shared/db/connection'
import { WizardSession } from '@shared/db/models/WizardSession'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { ReviewSubmitSchema } from '@resume/wizard/validators/wizardSchemas'
import { calculateStrengthScore } from '@resume/wizard/services/strengthScorer'
import type { ReviewSubmitInput } from '@resume/wizard/validators/wizardSchemas'

export const dynamic = 'force-dynamic'

export const POST = composeApiRoute<ReviewSubmitInput>({
  schema: ReviewSubmitSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 10, keyPrefix: 'rl:wiz-review' },
  handler: async (_req, { user, body }) => {
    await connectDB()

    const session = await WizardSession.findById(body.sessionId)
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }
    if (session.userId.toString() !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Group decisions by roleId
    const decisionsByRole = new Map<string, Array<{ bulletIndex: number; decision: string; editedText?: string }>>()
    for (const d of body.bulletDecisions) {
      const existing = decisionsByRole.get(d.roleId) || []
      existing.push({ bulletIndex: d.bulletIndex, decision: d.decision, editedText: d.editedText })
      decisionsByRole.set(d.roleId, existing)
    }

    // Apply decisions to each role
    for (const role of session.roles) {
      const decisions = decisionsByRole.get(role.id)
      if (!decisions) continue

      role.bulletDecisions = decisions.map(d => ({
        index: d.bulletIndex,
        decision: d.decision as 'accept' | 'reject' | 'edit',
        editedText: d.editedText,
      }))

      // Compute final bullets
      const finalBullets: string[] = []
      const enhanced = role.enhancedBullets || []
      const raw = role.rawBullets || []

      for (const d of decisions) {
        const enhancedBullet = enhanced[d.bulletIndex]
        const rawBullet = raw[d.bulletIndex]

        switch (d.decision) {
          case 'accept':
            finalBullets.push(enhancedBullet || rawBullet || '')
            break
          case 'reject':
            finalBullets.push(rawBullet || '')
            break
          case 'edit':
            finalBullets.push(d.editedText || enhancedBullet || rawBullet || '')
            break
        }
      }

      // Include any bullets without decisions (keep enhanced or raw)
      const maxBullets = Math.max(enhanced.length, raw.length)
      for (let i = decisions.length; i < maxBullets; i++) {
        finalBullets.push(enhanced[i] || raw[i] || '')
      }

      role.finalBullets = finalBullets.filter(b => b.trim())
    }

    // Handle summary decision
    if (body.summaryDecision === 'accept') {
      session.finalSummary = session.generatedSummary
    } else if (body.summaryDecision === 'edit' && body.editedSummary) {
      session.finalSummary = body.editedSummary
    }
    // 'reject' leaves finalSummary empty

    session.currentStage = 7

    // Recalculate strength score
    const { total, breakdown } = calculateStrengthScore({
      contactInfo: session.contactInfo,
      roles: session.roles,
      education: session.education,
      skills: session.skills,
      projects: session.projects,
      certifications: session.certifications,
      finalSummary: session.finalSummary,
      generatedSummary: session.generatedSummary,
    })
    session.strengthScore = total
    session.strengthBreakdown = breakdown

    await session.save()

    // Calculate acceptance rate
    const totalDecisions = body.bulletDecisions.length
    const accepted = body.bulletDecisions.filter(d => d.decision === 'accept' || d.decision === 'edit').length
    const acceptanceRate = totalDecisions > 0 ? accepted / totalDecisions : 0

    return NextResponse.json({
      success: true,
      currentStage: 7,
      acceptanceRate,
      strengthScore: total,
      strengthBreakdown: breakdown,
    })
  },
})
