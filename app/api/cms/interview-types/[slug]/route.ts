import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/authOptions'
import { connectDB } from '@/lib/db/connection'
import { InterviewDepth } from '@/lib/db/models'

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
    console.error('CMS GET /interview-types/[slug] error:', err)
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
    const body = await req.json()

    delete body._id
    delete body.createdAt
    delete body.updatedAt

    const interviewType = await InterviewDepth.findOneAndUpdate(
      { slug: params.slug },
      { $set: body },
      { new: true, runValidators: true }
    ).lean()

    if (!interviewType) {
      return NextResponse.json({ error: 'Interview type not found' }, { status: 404 })
    }
    return NextResponse.json({ interviewType })
  } catch (err) {
    console.error('CMS PUT /interview-types/[slug] error:', err)
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
    console.error('CMS DELETE /interview-types/[slug] error:', err)
    return NextResponse.json({ error: 'Failed to delete interview type' }, { status: 500 })
  }
}
