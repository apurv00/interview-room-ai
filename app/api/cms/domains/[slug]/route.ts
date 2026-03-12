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

export async function GET(
  _req: NextRequest,
  { params }: { params: { slug: string } }
) {
  try {
    const auth = await requireAdmin()
    if ('error' in auth && auth.error) return auth.error

    await connectDB()
    const domain = await InterviewDomain.findOne({ slug: params.slug }).lean()
    if (!domain) {
      return NextResponse.json({ error: 'Domain not found' }, { status: 404 })
    }
    return NextResponse.json({ domain })
  } catch (err) {
    console.error('CMS GET /domains/[slug] error:', err)
    return NextResponse.json({ error: 'Failed to fetch domain' }, { status: 500 })
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

    const domain = await InterviewDomain.findOneAndUpdate(
      { slug: params.slug },
      { $set: body },
      { new: true, runValidators: true }
    ).lean()

    if (!domain) {
      return NextResponse.json({ error: 'Domain not found' }, { status: 404 })
    }
    return NextResponse.json({ domain })
  } catch (err) {
    console.error('CMS PUT /domains/[slug] error:', err)
    return NextResponse.json({ error: 'Failed to update domain' }, { status: 500 })
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
    const domain = await InterviewDomain.findOne({ slug: params.slug })
    if (!domain) {
      return NextResponse.json({ error: 'Domain not found' }, { status: 404 })
    }
    if (domain.isBuiltIn) {
      return NextResponse.json({ error: 'Cannot delete built-in domains' }, { status: 403 })
    }

    await InterviewDomain.deleteOne({ slug: params.slug })
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('CMS DELETE /domains/[slug] error:', err)
    return NextResponse.json({ error: 'Failed to delete domain' }, { status: 500 })
  }
}
