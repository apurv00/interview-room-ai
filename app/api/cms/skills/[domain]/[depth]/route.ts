import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { InterviewSkill } from '@shared/db/models'
import { UpdateSkillSchema, validateSkillSections } from '@cms/validators/skills'
import { getDefaultSkillContent, invalidateSkillCache } from '@interview/services/skillLoader'
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

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ domain: string; depth: string }> }
) {
  try {
    const auth = await requireAdmin()
    if ('error' in auth && auth.error) return auth.error

    const { domain, depth } = await params
    await connectDB()

    // Try DB first
    const dbSkill = await InterviewSkill.findOne({ domain, depth }).lean()

    // Get filesystem default for comparison
    const defaultContent = getDefaultSkillContent(domain, depth)

    if (!dbSkill && !defaultContent) {
      return NextResponse.json({ error: 'Skill not found' }, { status: 404 })
    }

    return NextResponse.json({
      domain,
      depth,
      content: dbSkill?.content || defaultContent || '',
      isActive: dbSkill?.isActive ?? true,
      hasCustomContent: !!dbSkill,
      defaultContent: defaultContent || '',
      lastEditedAt: dbSkill?.lastEditedAt || null,
      lastEditedBy: dbSkill?.lastEditedBy || null,
      version: dbSkill?.version || 0,
    })
  } catch (err) {
    logger.error({ err }, 'CMS GET /skills/[domain]/[depth] error')
    return NextResponse.json({ error: 'Failed to fetch skill' }, { status: 500 })
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ domain: string; depth: string }> }
) {
  try {
    const auth = await requireAdmin()
    if ('error' in auth && auth.error) return auth.error

    const { domain, depth } = await params
    const body = await req.json()
    const parsed = UpdateSkillSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.issues }, { status: 400 })
    }

    // Validate sections (warnings, not errors)
    const missingSections = validateSkillSections(parsed.data.content)

    await connectDB()

    const update = {
      content: parsed.data.content,
      ...(parsed.data.isActive !== undefined && { isActive: parsed.data.isActive }),
      lastEditedBy: auth.session.user.id,
      lastEditedAt: new Date(),
      $inc: { version: 1 },
    }

    const skill = await InterviewSkill.findOneAndUpdate(
      { domain, depth },
      { $set: { content: update.content, lastEditedBy: update.lastEditedBy, lastEditedAt: update.lastEditedAt, ...(parsed.data.isActive !== undefined && { isActive: parsed.data.isActive }) }, $inc: { version: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    )

    // Invalidate cache so changes take effect immediately
    invalidateSkillCache(domain, depth)

    return NextResponse.json({
      skill: {
        domain: skill.domain,
        depth: skill.depth,
        version: skill.version,
        isActive: skill.isActive,
        lastEditedAt: skill.lastEditedAt,
      },
      warnings: missingSections.length > 0
        ? { missingSections, message: `Missing recommended sections: ${missingSections.join(', ')}` }
        : null,
    })
  } catch (err) {
    logger.error({ err }, 'CMS PUT /skills/[domain]/[depth] error')
    return NextResponse.json({ error: 'Failed to update skill' }, { status: 500 })
  }
}
