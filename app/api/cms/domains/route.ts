import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { InterviewDomain } from '@shared/db/models'
import { CreateDomainSchema } from '@cms/validators/cms'
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

export async function GET() {
  try {
    const auth = await requireAdmin()
    if ('error' in auth && auth.error) return auth.error

    await connectDB()
    const domains = await InterviewDomain.find({}).sort({ sortOrder: 1, label: 1 }).lean()
    return NextResponse.json({ domains })
  } catch (err) {
    logger.error({ err }, 'CMS GET /domains error')
    return NextResponse.json({ error: 'Failed to fetch domains' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAdmin()
    if ('error' in auth && auth.error) return auth.error

    await connectDB()
    const raw = await req.json()
    const parsed = CreateDomainSchema.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.issues.map(e => ({ path: e.path.join('.'), message: e.message })) },
        { status: 400 }
      )
    }
    const body = parsed.data

    const domain = await InterviewDomain.create({
      slug: body.slug,
      label: body.label,
      shortLabel: body.shortLabel,
      icon: body.icon,
      description: body.description,
      color: body.color || 'indigo',
      category: body.category,
      systemPromptContext: body.systemPromptContext || '',
      sampleQuestions: body.sampleQuestions || [],
      evaluationEmphasis: body.evaluationEmphasis || [],
      isBuiltIn: false,
      isActive: true,
      sortOrder: body.sortOrder || 0,
    })

    return NextResponse.json({ domain }, { status: 201 })
  } catch (err: unknown) {
    logger.error({ err }, 'CMS POST /domains error')
    if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 11000) {
      return NextResponse.json({ error: 'Domain slug already exists' }, { status: 409 })
    }
    return NextResponse.json({ error: 'Failed to create domain' }, { status: 500 })
  }
}
