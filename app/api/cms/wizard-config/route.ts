import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { WizardConfig } from '@shared/db/models'
import { UpdateWizardCostCapSchema } from '@cms/validators/cms'
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
    const config = await WizardConfig.getConfig()
    return NextResponse.json({ config })
  } catch (err) {
    logger.error({ err }, 'CMS GET /wizard-config error')
    return NextResponse.json({ error: 'Failed to fetch wizard config' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  try {
    const auth = await requireAdmin()
    if ('error' in auth && auth.error) return auth.error

    await connectDB()
    const raw = await req.json()
    const parsed = UpdateWizardCostCapSchema.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.issues.map(e => ({ path: e.path.join('.'), message: e.message })) },
        { status: 400 }
      )
    }

    const config = await WizardConfig.findOneAndUpdate(
      {},
      {
        $set: {
          costCapEnabled: parsed.data.costCapEnabled,
          costCapUsd: parsed.data.costCapUsd,
          updatedBy: auth.session!.user.id,
        },
      },
      { upsert: true, returnDocument: 'after' }
    )

    return NextResponse.json({ config })
  } catch (err) {
    logger.error({ err }, 'CMS PUT /wizard-config error')
    return NextResponse.json({ error: 'Failed to update wizard config' }, { status: 500 })
  }
}
