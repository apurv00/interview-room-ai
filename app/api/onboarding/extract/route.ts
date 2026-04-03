import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { getAnthropicClient } from '@shared/services/llmClient'
import { authOptions } from '@shared/auth/authOptions'
import { ResumeExtractSchema, ExtractedProfileSchema } from '@shared/validators/onboarding'
import { aiLogger } from '@shared/logger'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'

export const dynamic = 'force-dynamic'

const client = getAnthropicClient()

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Rate limit: 5 resume extractions per user per minute (AI API call)
  const rateLimited = await checkRateLimit(session.user.id, {
    windowMs: 60_000,
    maxRequests: 5,
    keyPrefix: 'rl:extract',
  })
  if (rateLimited) return rateLimited

  const body = await req.json()
  const parsed = ResumeExtractSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid data' }, { status: 400 })
  }

  const resumeText = parsed.data.resumeText.slice(0, 4000)

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: `You extract structured profile information from resumes. Return ONLY valid JSON. For any field you cannot confidently determine, use null.`,
      messages: [{
        role: 'user',
        content: `Extract profile data from this resume:
<resume>${resumeText}</resume>

Return JSON matching this exact schema:
{
  "currentTitle": string | null,
  "currentIndustry": "tech"|"finance"|"consulting"|"healthcare"|"retail"|"media"|"government"|"education"|"startup"|"other" | null,
  "experienceLevel": "0-2"|"3-6"|"7+" | null,
  "inferredRole": "PM"|"SWE"|"Sales"|"MBA" | null,
  "isCareerSwitcher": boolean,
  "switchingFrom": string | null
}`,
      }],
    })

    const raw = message.content[0].type === 'text' ? message.content[0].text.trim() : '{}'
    const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    const extracted = JSON.parse(cleaned)

    // Validate against expected schema, falling back to nulls for invalid values
    const result = ExtractedProfileSchema.safeParse(extracted)
    if (result.success) {
      return NextResponse.json(result.data)
    }

    // Partial extraction — return what we can
    return NextResponse.json({
      currentTitle: typeof extracted.currentTitle === 'string' ? extracted.currentTitle : null,
      currentIndustry: extracted.currentIndustry || null,
      experienceLevel: extracted.experienceLevel || null,
      inferredRole: extracted.inferredRole || null,
      isCareerSwitcher: extracted.isCareerSwitcher ?? false,
      switchingFrom: typeof extracted.switchingFrom === 'string' ? extracted.switchingFrom : null,
    })
  } catch (err) {
    aiLogger.error({ err }, 'Resume extraction error')
    return NextResponse.json({
      currentTitle: null,
      currentIndustry: null,
      experienceLevel: null,
      inferredRole: null,
      isCareerSwitcher: false,
      switchingFrom: null,
    })
  }
}
