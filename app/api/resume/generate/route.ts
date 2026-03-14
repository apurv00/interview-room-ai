import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { enhanceSection, enhanceBullets, generateFullResume } from '@resume/services/resumeAIService'
import { GenerateSchema } from '@resume/validators/resume'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const parsed = GenerateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid data' }, { status: 400 })
  }

  const { action, sectionType, currentContent, targetRole, targetCompany, currentSections, bullets, context } = parsed.data

  if (action === 'enhance' && sectionType && currentContent) {
    const result = await enhanceSection(session.user.id, { sectionType, currentContent, targetRole, targetCompany })
    return NextResponse.json(result)
  }

  if (action === 'enhance_bullets' && bullets?.length) {
    const result = await enhanceBullets(session.user.id, { bullets, context })
    return NextResponse.json(result)
  }

  if (action === 'generate_full') {
    const result = await generateFullResume(session.user.id, { targetRole, targetCompany, currentSections })
    return NextResponse.json(result)
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
}
