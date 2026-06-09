import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { Category } from '@shared/db/models'
import { CreateCategorySchema } from '@cms/validators/cms'
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
    const categories = await Category.find({}).sort({ sortOrder: 1, label: 1 }).lean()
    return NextResponse.json({ categories })
  } catch (err) {
    logger.error({ err }, 'CMS GET /categories error')
    return NextResponse.json({ error: 'Failed to fetch categories' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAdmin()
    if ('error' in auth && auth.error) return auth.error

    await connectDB()
    const raw = await req.json()
    const parsed = CreateCategorySchema.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.issues.map(e => ({ path: e.path.join('.'), message: e.message })) },
        { status: 400 }
      )
    }
    const body = parsed.data

    const category = await Category.create({
      slug: body.slug,
      label: body.label,
      icon: body.icon,
      description: body.description,
      parentSlug: body.parentSlug,
      isBuiltIn: false,
      isActive: true,
      sortOrder: body.sortOrder || 0,
    })

    return NextResponse.json({ category }, { status: 201 })
  } catch (err: unknown) {
    logger.error({ err }, 'CMS POST /categories error')
    if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 11000) {
      return NextResponse.json({ error: 'Category slug already exists' }, { status: 409 })
    }
    return NextResponse.json({ error: 'Failed to create category' }, { status: 500 })
  }
}
