import { NextResponse } from 'next/server'
import { z } from 'zod'
import { JobsEmailConfig, JobsEmailSend } from '@shared/db/models'
import { requireCurrentPlatformAdmin } from '@jobs/services/adminAuth'
import { checkJobsRateLimit } from '@jobs/services/rateLimit'

export const dynamic = 'force-dynamic'
const ACTIVE_EMAIL_STREAMS = ['e0', 'e1', 'e2', 'e4'] as const
const TRANSACTIONAL_STREAMS = ['e0', 'e2'] as const
const SOLICITATION_STREAMS = ['e1', 'e3', 'e4'] as const
const INCIDENT_LIST_LIMIT = 20
const STALE_SOLICITATION_AGE_MS = 24 * 3600_000
const UNRESOLVED_FILTER = {
  sentAt: { $exists: false },
  operatorResolution: { $exists: false },
} as const

const incidentResolutionSchema = z.object({
  action: z.literal('closed-without-resend'),
  incidentId: z.string().regex(/^[a-f\d]{24}$/i),
  reason: z.string().trim().min(8).max(1000),
}).strict()

interface IncidentRow {
  _id: unknown
  userId: unknown
  stream: string
  dedupeKey: string
  incidentKind?: string
  createdAt: Date
}

interface ExistingIncident {
  sentAt?: Date
  operatorResolution?: {
    kind: string
  }
}

/**
 * /api/cms/jobs-ingest/email — the jobs email wave's admin switch surface
 * (EMAILS.md §2 guard 4). Its OWN sub-route rather than an extension of the
 * parent PATCH: one handler per singleton, one allowlist per contract
 * (adversarial review R29). Every operation re-checks current platform-admin
 * authority in Mongo rather than trusting the role snapshot in the session.
 */
function serializeIncident(row: IncidentRow) {
  return {
    id: String(row._id),
    userId: String(row.userId),
    stream: row.stream,
    dedupeKey: row.dedupeKey,
    ...(row.incidentKind ? { incidentKind: row.incidentKind } : {}),
    createdAt: row.createdAt,
  }
}

export async function GET() {
  const authorization = await requireCurrentPlatformAdmin()
  if (!authorization.ok) {
    if (authorization.response) return authorization.response
    return NextResponse.json({
      error: authorization.error,
      code: authorization.code,
      retryable: authorization.status === 503,
    }, { status: authorization.status })
  }

  const staleBefore = new Date(Date.now() - STALE_SOLICITATION_AGE_MS)
  const [
    config,
    counts,
    staleSolicitation,
    unstampedTransactional,
    transactionalIncidents,
    staleSolicitationIncidents,
  ] = await Promise.all([
    JobsEmailConfig.getConfig(),
    JobsEmailSend.aggregate([
      // Provider acceptance remains a send even if an operator closed the
      // alert just before a late success stamp won the race.
      { $match: { sentAt: { $exists: true } } },
      { $group: { _id: '$stream', n: { $sum: 1 } } },
    ]),
    // Reserved-but-unsent SOLICITATION rows older than 24h (EMAILS.md §2:
    // dashboard-surfaced, never auto-retried; losing a nudge is acceptable).
    JobsEmailSend.countDocuments({
      stream: { $in: SOLICITATION_STREAMS },
      ...UNRESOLVED_FILTER,
      createdAt: { $lt: staleBefore },
    }),
    // Unstamped TRANSACTIONAL rows are the alert-NOW class (Codex #531):
    // an E0/E2 without sentAt is a failed time-critical send whose 24h
    // recovery window is burning — no age cutoff.
    JobsEmailSend.countDocuments({
      stream: { $in: TRANSACTIONAL_STREAMS },
      ...UNRESOLVED_FILTER,
    }),
    JobsEmailSend.find({
      stream: { $in: TRANSACTIONAL_STREAMS },
      ...UNRESOLVED_FILTER,
    })
      .sort({ createdAt: 1, _id: 1 })
      .limit(INCIDENT_LIST_LIMIT)
      .select('_id userId stream dedupeKey incidentKind createdAt')
      .lean(),
    JobsEmailSend.find({
      stream: { $in: SOLICITATION_STREAMS },
      ...UNRESOLVED_FILTER,
      createdAt: { $lt: staleBefore },
    })
      .sort({ createdAt: 1, _id: 1 })
      .limit(INCIDENT_LIST_LIMIT)
      .select('_id userId stream dedupeKey incidentKind createdAt')
      .lean(),
  ])
  return NextResponse.json({
    config,
    sentByStream: Object.fromEntries(
      ACTIVE_EMAIL_STREAMS.map((stream) => [
        stream,
        (counts as Array<{ _id: string; n: number }>).find((count) => count._id === stream)?.n ?? 0,
      ])
    ),
    staleReservations: staleSolicitation,
    unstampedTransactional,
    incidents: {
      transactional: (transactionalIncidents as unknown as IncidentRow[]).map(serializeIncident),
      staleSolicitation: (staleSolicitationIncidents as unknown as IncidentRow[]).map(serializeIncident),
    },
  })
}

const BOOL_KEYS = ['e0Enabled', 'e1Enabled', 'e2Enabled', 'e4Enabled'] as const

export async function PATCH(req: Request) {
  const authorization = await requireCurrentPlatformAdmin()
  if (!authorization.ok) {
    if (authorization.response) return authorization.response
    return NextResponse.json({
      error: authorization.error,
      code: authorization.code,
      retryable: authorization.status === 503,
    }, { status: authorization.status })
  }

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

/**
 * Closes an unresolved ledger incident without sending or changing delivery
 * truth. The row itself is the idempotency fence: only an unstamped,
 * unresolved, currently eligible row can receive its first resolution.
 */
export async function POST(req: Request) {
  const authorization = await requireCurrentPlatformAdmin({
    beforeAuthorityLookup: (actorUserId) => checkJobsRateLimit(actorUserId, 'admin-command'),
  })
  if (!authorization.ok) {
    if (authorization.response) return authorization.response
    return NextResponse.json({
      error: authorization.error,
      code: authorization.code,
      retryable: authorization.status === 503,
    }, { status: authorization.status })
  }

  let input: unknown
  try {
    input = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON', code: 'INVALID_JSON' }, { status: 400 })
  }
  const parsed = incidentResolutionSchema.safeParse(input)
  if (!parsed.success) {
    return NextResponse.json({
      error: 'invalid email incident resolution',
      code: 'INVALID_EMAIL_INCIDENT_RESOLUTION',
      issues: parsed.error.issues,
    }, { status: 400 })
  }

  const now = new Date()
  const staleBefore = new Date(now.getTime() - STALE_SOLICITATION_AGE_MS)
  const operatorResolution = {
    kind: parsed.data.action,
    reason: parsed.data.reason,
    actorUserId: authorization.actorUserId,
    at: now,
  }
  const result = await JobsEmailSend.updateOne({
    _id: parsed.data.incidentId,
    ...UNRESOLVED_FILTER,
    $or: [
      { stream: { $in: TRANSACTIONAL_STREAMS } },
      {
        stream: { $in: SOLICITATION_STREAMS },
        createdAt: { $lt: staleBefore },
      },
    ],
  }, {
    $set: { operatorResolution },
  })

  if (result.modifiedCount === 1) {
    return NextResponse.json({
      ok: true,
      idempotent: false,
      incidentId: parsed.data.incidentId,
    })
  }

  const existing = await JobsEmailSend.findById(parsed.data.incidentId)
    .select('sentAt operatorResolution')
    .lean() as ExistingIncident | null
  if (!existing) {
    return NextResponse.json({
      error: 'email incident not found',
      code: 'EMAIL_INCIDENT_NOT_FOUND',
    }, { status: 404 })
  }
  if (existing.operatorResolution) {
    return NextResponse.json({
      ok: true,
      idempotent: true,
      incidentId: parsed.data.incidentId,
    })
  }
  return NextResponse.json({
    error: 'email incident is no longer eligible for resolution',
    code: 'EMAIL_INCIDENT_NOT_RESOLVABLE',
  }, { status: 409 })
}
