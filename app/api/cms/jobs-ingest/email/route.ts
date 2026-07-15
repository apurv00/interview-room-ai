import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { JobsEmailConfig, JobsEmailSend, JOBS_EMAIL_STREAMS } from '@shared/db/models'

export const dynamic = 'force-dynamic'

/**
 * /api/cms/jobs-ingest/email — the jobs email wave's admin switch surface
 * (EMAILS.md §2 guard 4). Its OWN sub-route rather than an extension of the
 * parent PATCH: one handler per singleton, one allowlist per contract
 * (adversarial review R29). Same local platform_admin gate as the parent
 * (score-telemetry pattern).
 */
async function requireAdmin() {
  const session = await getServerSession(authOptions)
  if (!session?.user) return { status: 401 as const }
  if ((session.user as { role?: string }).role !== 'platform_admin') return { status: 403 as const }
  return null
}

export async function GET() {
  const denied = await requireAdmin()
  if (denied) return NextResponse.json({ error: 'platform_admin required' }, { status: denied.status })

  await connectDB()
  const [config, counts, unstamped] = await Promise.all([
    JobsEmailConfig.getConfig(),
    JobsEmailSend.aggregate([
      { $match: { sentAt: { $exists: true } } },
      { $group: { _id: '$stream', n: { $sum: 1 } } },
    ]),
    // Reserved-but-unsent solicitation rows older than 24h (EMAILS.md §2:
    // dashboard-surfaced, never auto-retried) + unstamped transactional
    // rows (alert-now class).
    JobsEmailSend.countDocuments({
      sentAt: { $exists: false },
      createdAt: { $lt: new Date(Date.now() - 24 * 3600_000) },
    }),
  ])
  return NextResponse.json({
    config,
    sentByStream: Object.fromEntries(
      JOBS_EMAIL_STREAMS.map((s) => [s, (counts as Array<{ _id: string; n: number }>).find((c) => c._id === s)?.n ?? 0])
    ),
    staleReservations: unstamped,
  })
}

const BOOL_KEYS = ['e0Enabled', 'e1Enabled', 'e2Enabled', 'e3Enabled', 'e4Enabled'] as const

export async function PATCH(req: Request) {
  const denied = await requireAdmin()
  if (denied) return NextResponse.json({ error: 'platform_admin required' }, { status: denied.status })

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 })
  }

  // Strict allowlist — unknown keys are rejected loudly, not dropped
  // silently (a typo'd switch name must never read as success).
  const set: Record<string, boolean | number> = {}
  for (const [k, v] of Object.entries(body)) {
    if ((BOOL_KEYS as readonly string[]).includes(k)) {
      if (typeof v !== 'boolean') return NextResponse.json({ error: `${k} must be boolean` }, { status: 400 })
      set[k] = v
    } else if (k === 'globalWeeklyCap') {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 20) {
        return NextResponse.json({ error: 'globalWeeklyCap must be an integer 0-20' }, { status: 400 })
      }
      set[k] = v
    } else {
      return NextResponse.json({ error: `unknown key: ${k}` }, { status: 400 })
    }
  }
  if (Object.keys(set).length === 0) return NextResponse.json({ error: 'no valid keys' }, { status: 400 })

  await connectDB()
  // Keyed upsert against the unique singleton index: a concurrent first
  // PATCH loses the insert race with E11000 — retry once, it now matches
  // the winner's doc (Codex #531).
  try {
    await JobsEmailConfig.updateOne({ key: 'singleton' }, { $set: set }, { upsert: true })
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      await JobsEmailConfig.updateOne({ key: 'singleton' }, { $set: set })
    } else {
      throw err
    }
  }
  return NextResponse.json({ ok: true, config: await JobsEmailConfig.getConfig() })
}
