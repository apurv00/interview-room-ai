import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { InterviewSkill } from '@shared/db/models'
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

const DOMAINS = [
  'general', 'frontend', 'backend', 'sdet', 'data-science',
  'pm', 'design', 'business',
]
const DEPTHS = ['behavioral', 'technical', 'case-study']

const DOMAIN_LABELS: Record<string, string> = {
  general: 'General / Any Role', frontend: 'Frontend Engineer', backend: 'Backend / Infra Engineer',
  sdet: 'SDET / QA', 'data-science': 'Data Science / ML', pm: 'Product Manager',
  design: 'Design / UX', business: 'Business & Strategy',
}
const DEPTH_LABELS: Record<string, string> = {
  behavioral: 'Behavioral', technical: 'Technical', 'case-study': 'Case Study',
}

export async function GET() {
  try {
    const auth = await requireAdmin()
    if ('error' in auth && auth.error) return auth.error

    await connectDB()
    const dbSkills = await InterviewSkill.find({}).select('domain depth isActive lastEditedAt version').lean()

    // Build full matrix — mark which ones have DB overrides
    const dbMap = new Map(dbSkills.map(s => [`${s.domain}:${s.depth}`, s]))

    const skills = DOMAINS.flatMap(domain =>
      DEPTHS.map(depth => {
        const key = `${domain}:${depth}`
        const dbEntry = dbMap.get(key)
        return {
          domain,
          depth,
          domainLabel: DOMAIN_LABELS[domain] || domain,
          depthLabel: DEPTH_LABELS[depth] || depth,
          hasCustomContent: !!dbEntry,
          isActive: dbEntry?.isActive ?? true,
          lastEditedAt: dbEntry?.lastEditedAt || null,
          version: dbEntry?.version || 0,
        }
      })
    )

    return NextResponse.json({ skills })
  } catch (err) {
    logger.error({ err }, 'CMS GET /skills error')
    return NextResponse.json({ error: 'Failed to fetch skills' }, { status: 500 })
  }
}
