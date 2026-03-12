import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/authOptions'
import { connectDB } from '@/lib/db/connection'
import { InterviewDomain } from '@/lib/db/models'

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
    console.error('CMS GET /domains error:', err)
    return NextResponse.json({ error: 'Failed to fetch domains' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAdmin()
    if ('error' in auth && auth.error) return auth.error

    await connectDB()
    const body = await req.json()

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
    console.error('CMS POST /domains error:', err)
    if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 11000) {
      return NextResponse.json({ error: 'Domain slug already exists' }, { status: 409 })
    }
    return NextResponse.json({ error: 'Failed to create domain' }, { status: 500 })
  }
}
