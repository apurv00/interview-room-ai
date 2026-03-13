import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { InterviewDomain } from '@shared/db/models'
import { UpdateDomainSchema } from '@/lib/validators/cms'
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
    const domain = await InterviewDomain.findOne({ slug: params.slug }).lean()
    if (!domain) {
      return NextResponse.json({ error: 'Domain not found' }, { status: 404 })
    }
    return NextResponse.json({ domain })
  } catch (err) {
    logger.error({ err }, 'CMS GET /domains/[slug] error')
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
    const raw = await req.json()
    const parsed = UpdateDomainSchema.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.issues.map(e => ({ path: e.path.join('.'), message: e.message })) },
        { status: 400 }
      )
    }

    const domain = await InterviewDomain.findOneAndUpdate(
      { slug: params.slug },
      { $set: parsed.data },
      { new: true, runValidators: true }
    ).lean()

    if (!domain) {
      return NextResponse.json({ error: 'Domain not found' }, { status: 404 })
    }
    return NextResponse.json({ domain })
  } catch (err) {
    logger.error({ err }, 'CMS PUT /domains/[slug] error')
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
    logger.error({ err }, 'CMS DELETE /domains/[slug] error')
    return NextResponse.json({ error: 'Failed to delete domain' }, { status: 500 })
  }
}
