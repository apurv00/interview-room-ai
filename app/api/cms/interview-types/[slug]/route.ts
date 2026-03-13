import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { InterviewDepth } from '@shared/db/models'
import { UpdateInterviewTypeSchema } from '@/lib/validators/cms'
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
  _req: NextRequest,
  { params }: { params: { slug: string } }
) {
  try {
    const auth = await requireAdmin()
    if ('error' in auth && auth.error) return auth.error

    await connectDB()
    const interviewType = await InterviewDepth.findOne({ slug: params.slug }).lean()
    if (!interviewType) {
      return NextResponse.json({ error: 'Interview type not found' }, { status: 404 })
    }
    return NextResponse.json({ interviewType })
  } catch (err) {
    logger.error({ err }, 'CMS GET /interview-types/[slug] error')
    return NextResponse.json({ error: 'Failed to fetch interview type' }, { status: 500 })
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: { slug: string } }
) {
  try {
    const auth = await requireAdmin()
    if ('error' in auth && auth.error) return auth.error

    await connectDB()
    const raw = await req.json()
    const parsed = UpdateInterviewTypeSchema.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.issues.map(e => ({ path: e.path.join('.'), message: e.message })) },
        { status: 400 }
      )
    }

    const interviewType = await InterviewDepth.findOneAndUpdate(
      { slug: params.slug },
      { $set: parsed.data },
      { new: true, runValidators: true }
    ).lean()

    if (!interviewType) {
      return NextResponse.json({ error: 'Interview type not found' }, { status: 404 })
    }
    return NextResponse.json({ interviewType })
  } catch (err) {
    logger.error({ err }, 'CMS PUT /interview-types/[slug] error')
    return NextResponse.json({ error: 'Failed to update interview type' }, { status: 500 })
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { slug: string } }
) {
  try {
    const auth = await requireAdmin()
    if ('error' in auth && auth.error) return auth.error

    await connectDB()
    const interviewType = await InterviewDepth.findOne({ slug: params.slug })
    if (!interviewType) {
      return NextResponse.json({ error: 'Interview type not found' }, { status: 404 })
    }
    if (interviewType.isBuiltIn) {
      return NextResponse.json({ error: 'Cannot delete built-in interview types' }, { status: 403 })
    }

    await InterviewDepth.deleteOne({ slug: params.slug })
    return NextResponse.json({ success: true })
  } catch (err) {
    logger.error({ err }, 'CMS DELETE /interview-types/[slug] error')
    return NextResponse.json({ error: 'Failed to delete interview type' }, { status: 500 })
  }
}
