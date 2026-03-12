import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/authOptions'
import { connectDB } from '@/lib/db/connection'
import { InterviewDepth } from '@/lib/db/models'
import { CreateInterviewTypeSchema } from '@/lib/validators/cms'
import { logger } from '@/lib/logger'

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

export async function GET() {
  try {
    const auth = await requireAdmin()
    if ('error' in auth && auth.error) return auth.error

    await connectDB()
    const interviewTypes = await InterviewDepth.find({}).sort({ sortOrder: 1, label: 1 }).lean()
    return NextResponse.json({ interviewTypes })
  } catch (err) {
    logger.error({ err }, 'CMS GET /interview-types error')
    return NextResponse.json({ error: 'Failed to fetch interview types' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAdmin()
    if ('error' in auth && auth.error) return auth.error

    await connectDB()
    const raw = await req.json()
    const parsed = CreateInterviewTypeSchema.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.issues.map(e => ({ path: e.path.join('.'), message: e.message })) },
        { status: 400 }
      )
    }
    const body = parsed.data

    const interviewType = await InterviewDepth.create({
      slug: body.slug,
      label: body.label,
      icon: body.icon,
      description: body.description,
      systemPromptTemplate: body.systemPromptTemplate || '',
      questionStrategy: body.questionStrategy || '',
      evaluationCriteria: body.evaluationCriteria || '',
      avatarPersona: body.avatarPersona || '',
      scoringDimensions: body.scoringDimensions || [],
      applicableDomains: body.applicableDomains || [],
      isBuiltIn: false,
      isActive: true,
      sortOrder: body.sortOrder || 0,
    })

    return NextResponse.json({ interviewType }, { status: 201 })
  } catch (err: unknown) {
    logger.error({ err }, 'CMS POST /interview-types error')
    if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 11000) {
      return NextResponse.json({ error: 'Interview type slug already exists' }, { status: 409 })
    }
    return NextResponse.json({ error: 'Failed to create interview type' }, { status: 500 })
  }
}
