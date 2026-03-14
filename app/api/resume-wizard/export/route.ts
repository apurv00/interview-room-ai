import { NextResponse } from 'next/server'
import { connectDB } from '@shared/db/connection'
import { WizardSession } from '@shared/db/models/WizardSession'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { ExportWizardSchema } from '@resume/wizard/validators/wizardSchemas'
import { saveResume } from '@resume/services/resumeService'
import { generatePDF } from '@resume/services/pdfService'
import type { ExportWizardInput } from '@resume/wizard/validators/wizardSchemas'
import type { ResumeData } from '@resume/validators/resume'

export const dynamic = 'force-dynamic'

export const POST = composeApiRoute<ExportWizardInput>({
  schema: ExportWizardSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 5, keyPrefix: 'rl:wiz-export' },
  handler: async (_req, { user, body }) => {
    await connectDB()

    const session = await WizardSession.findById(body.sessionId)
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }
    if (session.userId.toString() !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const templateId = body.template || session.selectedTemplate || 'professional'

    // Map WizardSession to ResumeData
    const resumeData: ResumeData = {
      name: `Resume - ${session.contactInfo?.fullName || 'Untitled'}`,
      template: templateId,
      contactInfo: session.contactInfo ? {
        fullName: session.contactInfo.fullName,
        email: session.contactInfo.email,
        phone: session.contactInfo.phone,
        location: session.contactInfo.city,
        linkedin: session.contactInfo.linkedInUrl,
      } : undefined,
      summary: session.finalSummary || session.generatedSummary || undefined,
      experience: session.roles.map(r => ({
        id: r.id,
        company: r.company,
        title: r.title,
        location: r.location,
        startDate: r.startDate,
        endDate: r.endDate,
        bullets: r.finalBullets.length > 0 ? r.finalBullets : r.rawBullets,
      })),
      education: session.education.map(e => ({
        id: e.id,
        institution: e.institution,
        degree: e.degree,
        field: e.field,
        graduationDate: e.graduationDate,
        gpa: e.gpa,
        honors: e.honors,
      })),
      skills: [
        ...(session.skills.hard.length > 0 ? [{ category: 'Hard Skills', items: session.skills.hard }] : []),
        ...(session.skills.soft.length > 0 ? [{ category: 'Soft Skills', items: session.skills.soft }] : []),
        ...(session.skills.technical.length > 0 ? [{ category: 'Technical Skills', items: session.skills.technical }] : []),
      ],
      projects: session.projects.map(p => ({
        id: p.id,
        name: p.name,
        description: p.description,
        technologies: p.technologies,
        url: p.url,
      })),
      certifications: session.certifications.map(c => ({
        name: c.name,
        issuer: c.issuer,
        date: c.date,
      })),
    }

    // Save to User.savedResumes via existing service
    const saveResult = await saveResume(user.id, resumeData)

    if ('error' in saveResult) {
      return NextResponse.json({ error: saveResult.error, code: saveResult.code }, { status: 400 })
    }

    // Mark session as completed
    session.status = 'completed'
    session.selectedTemplate = templateId
    session.exportedResumeId = saveResult.id
    await session.save()

    // Generate PDF
    try {
      const pdfBuffer = await generatePDF(resumeData, templateId)
      const fileName = `Resume_${(session.contactInfo?.fullName || 'Resume').replace(/\s+/g, '_')}.pdf`

      return new NextResponse(new Uint8Array(pdfBuffer), {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${fileName}"`,
          'Content-Length': String(pdfBuffer.length),
        },
      })
    } catch {
      // PDF generation failed, but save succeeded — return JSON with resumeId
      return NextResponse.json({
        success: true,
        resumeId: saveResult.id,
        message: 'Resume saved. PDF generation unavailable — use browser print instead.',
        templateId,
      })
    }
  },
})
