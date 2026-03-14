import { NextResponse } from 'next/server'
import { connectDB } from '@shared/db/connection'
import { WizardSession } from '@shared/db/models/WizardSession'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { SubmitStageSchema } from '@resume/wizard/validators/wizardSchemas'
import { calculateStrengthScore } from '@resume/wizard/services/strengthScorer'
import type { SubmitStageInput } from '@resume/wizard/validators/wizardSchemas'

export const dynamic = 'force-dynamic'

export const POST = composeApiRoute<SubmitStageInput>({
  schema: SubmitStageSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 20, keyPrefix: 'rl:wiz-stage' },
  handler: async (_req, { user, body }) => {
    await connectDB()

    const session = await WizardSession.findById(body.sessionId)
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }
    if (session.userId.toString() !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { stage } = body.data

    // Apply stage data
    switch (stage) {
      case 1:
        session.contactInfo = body.data.contactInfo
        session.currentStage = 2
        break

      case 2:
        session.roles = body.data.roles.map(r => ({
          id: r.id,
          company: r.company,
          title: r.title,
          location: r.location,
          startDate: r.startDate,
          endDate: r.endDate,
          rawBullets: r.rawBullets,
          followUpQuestions: [],
          enhancedBullets: [],
          bulletDecisions: [],
          finalBullets: [],
        }))
        session.currentStage = 3
        break

      case 3:
        session.education = body.data.education.map(e => ({
          id: e.id,
          institution: e.institution,
          degree: e.degree,
          field: e.field,
          graduationDate: e.graduationDate,
          gpa: e.gpa,
          honors: e.honors,
        }))
        session.currentStage = 4
        break

      case 4:
        session.skills = body.data.skills
        session.currentStage = 5
        break

      case 5:
        session.projects = (body.data.projects || []).map(p => ({
          id: p.id,
          name: p.name,
          description: p.description,
          technologies: p.technologies,
          url: p.url,
        }))
        session.certifications = (body.data.certifications || []).map(c => ({
          name: c.name,
          issuer: c.issuer,
          date: c.date,
        }))
        session.currentStage = 6
        break
    }

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

    return NextResponse.json({
      success: true,
      currentStage: session.currentStage,
      strengthScore: total,
      strengthBreakdown: breakdown,
    })
  },
})
