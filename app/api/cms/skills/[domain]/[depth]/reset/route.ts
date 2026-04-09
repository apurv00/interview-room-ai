import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { InterviewSkill } from '@shared/db/models'
import { getDefaultSkillContent, invalidateSkillCache } from '@interview/services/core/skillLoader'
import { logger } from '@shared/logger'

export const dynamic = 'force-dynamic'

async function requireAdmin() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  if (session.user.role !== 'platform_admin') {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }
  return { session }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ domain: string; depth: string }> }
) {
  try {
    const auth = await requireAdmin()
    if ('error' in auth && auth.error) return auth.error

    const { domain, depth } = await params
    const defaultContent = getDefaultSkillContent(domain, depth)

    if (!defaultContent) {
      return NextResponse.json({ error: 'No default skill file found' }, { status: 404 })
    }

    await connectDB()

    // Delete the DB override — skillLoader will fall back to filesystem
    await InterviewSkill.deleteOne({ domain, depth })

    // Invalidate cache
    invalidateSkillCache(domain, depth)

    return NextResponse.json({
      success: true,
      content: defaultContent,
      message: 'Skill reset to default filesystem content',
    })
  } catch (err) {
    logger.error({ err }, 'CMS POST /skills/[domain]/[depth]/reset error')
    return NextResponse.json({ error: 'Failed to reset skill' }, { status: 500 })
  }
}
