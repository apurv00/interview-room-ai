import { NextRequest, NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { parseResumeToStructured } from '@resume/services/resumeAIService'
import { ParseResumeSchema } from '@resume/validators/resume'

export const dynamic = 'force-dynamic'

const MAX_PARSE_BODY_BYTES = 128 * 1024
const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
} as const

function privateJson(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS })
}

function protectPrivateResponse(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', PRIVATE_HEADERS['Cache-Control'])
  response.headers.set('Pragma', PRIVATE_HEADERS.Pragma)
  return response
}

// Open to anonymous users so they can hydrate the resume builder from a paste
// or upload without signing in. The resume parser is stateless (no user.id
// dependency). Authed users get the regular per-minute limit; anonymous users
// are additionally capped at 10 parses per IP per day to bound abuse.
const composedPOST = composeApiRoute({
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
      if (result.inputTruncated) {
        warnings.push('Only the first 24,000 characters were inspected — review anything near the end of the resume.')
      }
      if (result.truncated) {
        warnings.push('The parser response ended early — some extracted fields may be incomplete.')
      }
      if (result.salvaged) {
        warnings.push('The parser response was incomplete, so only fully recovered fields were imported.')
      }
      const parseConfidence = warnings.length > 0 ? 'needs-review' : 'no-known-loss'
      return NextResponse.json({
        resume: result.resume,
        importedSections: result.importedSections,
        parseConfidence,
        warnings,
        // Machine-readable evidence behind the human warning. Consumers must
        // not infer semantic correctness from `parseConfidence`: it describes
        // known transport/normalization loss only.
        parseDiagnostics: {
          inputTruncated: result.inputTruncated,
          outputTruncated: result.truncated,
          salvaged: result.salvaged,
          droppedSections: result.droppedSections,
        },
        warning: warnings.length > 0 ? warnings.join(' ') : undefined,
      })
    } catch {
      return NextResponse.json({ error: 'Failed to parse resume' }, { status: 500 })
    }
  },
})

export async function POST(
  req: NextRequest,
  context?: { params?: Record<string, string> },
): Promise<NextResponse> {
  const declaredLength = Number(req.headers.get('content-length') ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PARSE_BODY_BYTES) {
    return privateJson({ error: 'Resume text is too large' }, 413)
  }
  return protectPrivateResponse(await composedPOST(req, context))
}
