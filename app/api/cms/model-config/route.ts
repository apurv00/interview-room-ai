import { NextRequest, NextResponse } from 'next/server'
import { connectDB } from '@shared/db/connection'
import { ModelConfig, TASK_SLOTS, TASK_SLOT_DEFAULTS } from '@shared/db/models'
import { UpdateModelConfigSchema } from '@cms/validators/cms'
import { replaceModelConfigCache } from '@shared/services/modelRouter'
import { getAllProviders } from '@shared/services/providers'
import { logger } from '@shared/logger'
import { jobsVerdictRoutePriceFloor } from '@jobs/config/verdictSchema'
import { requireCurrentPlatformAdmin } from '@jobs/services/adminAuth'

export const dynamic = 'force-dynamic'

async function requireAdmin() {
  const authorization = await requireCurrentPlatformAdmin()
  if (!authorization.ok) {
    if (authorization.cause) {
      logger.error({
        error: authorization.cause,
        actorUserId: authorization.actorUserId,
      }, 'model config authorization lookup failed')
    }
    return {
      error: NextResponse.json({
        error: authorization.error,
        code: authorization.code,
        retryable: authorization.status === 503,
      }, { status: authorization.status }),
    }
  }
  return { actorUserId: authorization.actorUserId }
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

    const seenTaskSlots = new Set<string>()
    for (const slot of parsed.data.slots) {
      if (!TASK_SLOTS.includes(slot.taskSlot as typeof TASK_SLOTS[number])) {
        return NextResponse.json(
          { error: `Invalid task slot: ${slot.taskSlot}` },
          { status: 400 }
        )
      }
      if (seenTaskSlots.has(slot.taskSlot)) {
        return NextResponse.json(
          { error: `Duplicate task slot: ${slot.taskSlot}` },
          { status: 400 },
        )
      }
      seenTaskSlots.add(slot.taskSlot)

      if (slot.taskSlot.startsWith('jobs.')) {
        if (slot.fallbackModel !== undefined || slot.fallbackProvider !== undefined) {
          return NextResponse.json(
            { error: `Jobs task slot ${slot.taskSlot} does not accept a configured fallback` },
            { status: 400 },
          )
        }
        if (slot.useToonInput) {
          return NextResponse.json(
            { error: `Jobs task slot ${slot.taskSlot} does not accept TOON input` },
            { status: 400 },
          )
        }
      }
    }

    const providers = new Map(getAllProviders().map((provider) => [provider.name, provider]))
    for (let index = 0; index < parsed.data.slots.length; index += 1) {
      const slot = parsed.data.slots[index]
      const primary = providers.get(slot.provider)
      if (!primary) {
        return NextResponse.json(
          { error: `Unknown provider for slots.${index}.provider: ${slot.provider}` },
          { status: 400 },
        )
      }
      if (parsed.data.routingEnabled && slot.isActive && !primary.configured) {
        return NextResponse.json(
          { error: `Provider "${slot.provider}" is not configured` },
          { status: 400 },
        )
      }
      if (
        parsed.data.routingEnabled &&
        slot.isActive &&
        slot.taskSlot === 'jobs.evaluate-posting' &&
        !jobsVerdictRoutePriceFloor(slot.provider, slot.model)
      ) {
        return NextResponse.json(
          { error: `Jobs verdict pricing is unavailable for ${slot.provider}/${slot.model}` },
          { status: 400 },
        )
      }

      if ((slot.fallbackModel === undefined) !== (slot.fallbackProvider === undefined)) {
        return NextResponse.json(
          { error: `slots.${index} must set fallbackModel and fallbackProvider together` },
          { status: 400 },
        )
      }
      if (slot.fallbackProvider) {
        const fallback = providers.get(slot.fallbackProvider)
        if (!fallback) {
          return NextResponse.json(
            { error: `Unknown provider for slots.${index}.fallbackProvider: ${slot.fallbackProvider}` },
            { status: 400 },
          )
        }
        if (parsed.data.routingEnabled && slot.isActive && !fallback.configured) {
          return NextResponse.json(
            { error: `Fallback provider "${slot.fallbackProvider}" is not configured` },
            { status: 400 },
          )
        }
      }
    }

    const config = await ModelConfig.findOneAndUpdate(
      {},
      {
        $set: {
          routingEnabled: parsed.data.routingEnabled,
          slots: parsed.data.slots,
          updatedBy: auth.actorUserId,
        },
      },
      { upsert: true, returnDocument: 'after' }
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
