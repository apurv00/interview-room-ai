import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { parseResumeToStructured } from '@resume/services/resumeAIService'
import { ParseResumeSchema } from '@resume/validators/resume'

export const dynamic = 'force-dynamic'

// Open to anonymous users so they can hydrate the resume builder from a paste
// or upload without signing in. The resume parser is stateless (no user.id
// dependency). Authed users get the regular per-minute limit; anonymous users
// are additionally capped at 10 parses per IP per day to bound abuse.
export const POST = composeApiRoute({
  schema: ParseResumeSchema,
  authOptional: true,
  rateLimit: {
    keyPrefix: 'rl:resume-parse',
    windowMs: 60_000,
    maxRequests: 5,
    anonDailyLimit: 10,
  },
  handler: async (_req, { body }) => {
    try {
      const result = await parseResumeToStructured(body.text)
      if (!result) {
        // Nothing salvageable — a real outcome (garbage text, scanned-PDF
        // residue), distinct from a server error: 422 with actionable copy.
        return NextResponse.json(
          { error: 'We could not extract structured sections from this text. Try a text-based PDF or DOCX export, or fill the sections in manually.' },
          { status: 422 },
        )
      }
      // Partial-tolerant contract: `resume` holds whatever sections survived
      // normalization; `warning` tells the user what did not make it.
      const warnings: string[] = []
      if (result.droppedSections.length > 0) {
        warnings.push(`Could not import: ${result.droppedSections.join(', ')}.`)
      }
      if (result.truncated) {
        warnings.push('The resume was very long — trailing content may be missing.')
      }
      return NextResponse.json({
        resume: result.resume,
        importedSections: result.importedSections,
        warning: warnings.length > 0 ? warnings.join(' ') : undefined,
      })
    } catch {
      return NextResponse.json({ error: 'Failed to parse resume' }, { status: 500 })
    }
  },
})
