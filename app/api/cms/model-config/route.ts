import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { ModelConfig, TASK_SLOTS, TASK_SLOT_DEFAULTS } from '@shared/db/models'
import { UpdateModelConfigSchema } from '@cms/validators/cms'
import { replaceModelConfigCache } from '@shared/services/modelRouter'
import { getAllProviders } from '@shared/services/providers'
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
    const doc = await ModelConfig.findOne().lean()

    return NextResponse.json({
      config: doc || { routingEnabled: false, slots: [] },
      taskSlots: TASK_SLOTS,
      defaults: TASK_SLOT_DEFAULTS,
      providers: getAllProviders(),
    })
  } catch (err) {
    logger.error({ err }, 'CMS GET /model-config error')
    return NextResponse.json({ error: 'Failed to fetch model config' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  try {
    const auth = await requireAdmin()
    if ('error' in auth && auth.error) return auth.error

    await connectDB()
    const raw = await req.json()
    const parsed = UpdateModelConfigSchema.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.issues.map(e => ({ path: e.path.join('.'), message: e.message })) },
        { status: 400 }
      )
    }

    for (const slot of parsed.data.slots) {
      if (!TASK_SLOTS.includes(slot.taskSlot as typeof TASK_SLOTS[number])) {
        return NextResponse.json(
          { error: `Invalid task slot: ${slot.taskSlot}` },
          { status: 400 }
        )
      }
    }

    const config = await ModelConfig.findOneAndUpdate(
      {},
      {
        $set: {
          routingEnabled: parsed.data.routingEnabled,
          slots: parsed.data.slots,
          updatedBy: auth.session!.user.id,
        },
      },
      { upsert: true, new: true }
    )

    // Directly populate L1/L2 with the just-saved config instead of
    // DEL'ing L2 and waiting for a background Mongo refresh. Closes
    // the window Codex P2 flagged on PR #308 where cold Lambdas saw
    // L2 empty and served TASK_SLOT_DEFAULTS between the DEL and the
    // next request's Mongo load — meaning admin changes that diverged
    // from defaults (routing toggle, provider swap) were silently
    // ignored on the first request after save.
    //
    // Awaited (not fire-and-forget) so the HTTP 200 implies "Redis is
    // ready for other Lambdas to read this config." If Redis is down,
    // the function still updates L1 on THIS Lambda and swallows the
    // error — admin save never fails on a transient Redis outage.
    await replaceModelConfigCache({
      routingEnabled: parsed.data.routingEnabled,
      slots: parsed.data.slots,
    })

    return NextResponse.json({ config })
  } catch (err) {
    logger.error({ err }, 'CMS PUT /model-config error')
    return NextResponse.json({ error: 'Failed to update model config' }, { status: 500 })
  }
}
