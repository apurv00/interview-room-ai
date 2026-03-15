import { NextRequest, NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { buildInterviewConfig } from '@resume/services/resumeService'

export const GET = composeApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 30, keyPrefix: 'resume:interview-config' },
  handler: async (req: NextRequest, { user }) => {
    const resumeId = req.nextUrl.searchParams.get('id')
    if (!resumeId) {
      return NextResponse.json({ error: 'Missing resume id' }, { status: 400 })
    }

    const config = await buildInterviewConfig(user.id, resumeId)
    if (!config) {
      return NextResponse.json({ error: 'Resume not found' }, { status: 404 })
    }

    return NextResponse.json(config)
  },
})
