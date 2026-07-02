import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { enhanceSection, enhanceBullets, generateFullResume } from '@resume/services/resumeAIService'
import { GenerateSchema } from '@resume/validators/resume'

export const dynamic = 'force-dynamic'

// This was the ONLY resume AI endpoint with no rate limit — an authed user
// could hammer three LLM task slots at will. 10/min matches the interactive
// cadence of the builder's enhance buttons (composeApiRoute scales it by
// plan tier); auth stays required, as before.
export const POST = composeApiRoute({
  schema: GenerateSchema,
  rateLimit: {
    keyPrefix: 'rl:resume-generate',
    windowMs: 60_000,
    maxRequests: 10,
  },
  handler: async (_req, { body, user }) => {
    const { action, sectionType, currentContent, targetRole, targetCompany, currentSections, bullets, context } = body

    if (action === 'enhance' && sectionType && currentContent) {
      const result = await enhanceSection(user.id, { sectionType, currentContent, targetRole, targetCompany })
      return NextResponse.json(result)
    }

    if (action === 'enhance_bullets' && bullets?.length) {
      const result = await enhanceBullets(user.id, { bullets, context })
      return NextResponse.json(result)
    }

    if (action === 'generate_full') {
      const result = await generateFullResume(user.id, { targetRole, targetCompany, currentSections })
      return NextResponse.json(result)
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  },
})
