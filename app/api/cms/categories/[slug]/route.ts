import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { Category, InterviewDomain } from '@shared/db/models'
import { UpdateCategorySchema } from '@cms/validators/cms'
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

export async function GET(_req: NextRequest, { params }: { params: { slug: string } }) {
  try {
    const auth = await requireAdmin()
    if ('error' in auth && auth.error) return auth.error

    await connectDB()
    const category = await Category.findOne({ slug: params.slug }).lean()
    if (!category) {
      return NextResponse.json({ error: 'Category not found' }, { status: 404 })
    }
    return NextResponse.json({ category })
  } catch (err) {
    logger.error({ err }, 'CMS GET /categories/[slug] error')
    return NextResponse.json({ error: 'Failed to fetch category' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest, { params }: { params: { slug: string } }) {
  try {
    const auth = await requireAdmin()
    if ('error' in auth && auth.error) return auth.error

    await connectDB()
    const raw = await req.json()
    const parsed = UpdateCategorySchema.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.issues.map(e => ({ path: e.path.join('.'), message: e.message })) },
        { status: 400 }
      )
    }

    const category = await Category.findOneAndUpdate(
      { slug: params.slug },
      { $set: parsed.data },
      { returnDocument: 'after', runValidators: true }
    ).lean()

    if (!category) {
      return NextResponse.json({ error: 'Category not found' }, { status: 404 })
    }
    return NextResponse.json({ category })
  } catch (err) {
    logger.error({ err }, 'CMS PUT /categories/[slug] error')
    return NextResponse.json({ error: 'Failed to update category' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { slug: string } }) {
  try {
    const auth = await requireAdmin()
    if ('error' in auth && auth.error) return auth.error

    await connectDB()
    const category = await Category.findOne({ slug: params.slug })
    if (!category) {
      return NextResponse.json({ error: 'Category not found' }, { status: 404 })
    }
    if (category.isBuiltIn) {
      return NextResponse.json({ error: 'Cannot delete built-in categories' }, { status: 403 })
    }
    // Don't orphan domains: block deletion while active roles reference this category.
    const inUse = await InterviewDomain.countDocuments({ categorySlug: params.slug, isActive: true })
    if (inUse > 0) {
      return NextResponse.json(
        { error: `Cannot delete: ${inUse} active ${inUse === 1 ? 'role' : 'roles'} still use this category. Reassign them first.` },
        { status: 409 }
      )
    }

    await Category.deleteOne({ slug: params.slug })
    return NextResponse.json({ success: true })
  } catch (err) {
    logger.error({ err }, 'CMS DELETE /categories/[slug] error')
    return NextResponse.json({ error: 'Failed to delete category' }, { status: 500 })
  }
}
