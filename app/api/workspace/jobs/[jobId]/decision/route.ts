/** Member-only, read-only decision action inbox for one job. */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { requireMembership } from '@hire'
import {
  readHireDecisionActionInbox,
  type HireDecisionActionInboxCursor,
} from '@hire-decisions'
import { AppError } from '@shared/errors'
import { composeHireApiRoute } from '../../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const CURSOR_VERSION = 2
const CURSOR_IV_BYTES = 12
const CURSOR_AUTH_TAG_BYTES = 16
const CURSOR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000
const CURSOR_FUTURE_SKEW_MS = 60_000
const OBJECT_ID = /^[a-f0-9]{24}$/i
const ACTION_KINDS = [
  'pending_human_scorecard',
  'terminal_human_kit_delivery_failure',
  'external_verdict_submitted',
] as const

interface DecisionInboxCursorPayload {
  v: 2
  resource: 'decision_action_inbox'
  issuedAt: number
  workspaceId: string
  jobId: string
  memberId: string
  limit: number
  externalVerdictsSince: string | null
  occurredAt: string
  kind: HireDecisionActionInboxCursor['kind']
  applicationId: string
  sourceId: string
}

interface DecisionInboxCursorScope {
  workspaceId: string
  jobId: string
  memberId: string
  limit: number
  externalVerdictsSince?: Date
}

interface DecisionInboxQuery {
  cursor: string | null
  externalVerdictsSince?: Date
  limit: number
}

function decisionInboxQuery(req: NextRequest): DecisionInboxQuery {
  const allowed = new Set(['cursor', 'externalVerdictsSince', 'limit'])
  const raw: Record<string, string> = {}
  for (const key of Array.from(req.nextUrl.searchParams.keys())) {
    const values = req.nextUrl.searchParams.getAll(key)
    if (!allowed.has(key) || values.length !== 1) {
      throw new AppError(
        'Invalid decision inbox query',
        400,
        'INVALID_DECISION_QUERY',
      )
    }
    raw[key] = values[0]
  }

  const rawLimit = raw.limit
  if (rawLimit !== undefined && !/^(?:[1-9]\d*)$/.test(rawLimit)) {
    throw new AppError('Invalid decision inbox limit', 400, 'INVALID_DECISION_LIMIT')
  }
  const limit = rawLimit === undefined ? DEFAULT_LIMIT : Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new AppError(
      `Decision inbox limit must be 1-${MAX_LIMIT}`,
      400,
      'INVALID_DECISION_LIMIT',
    )
  }

  let verdictsSince: Date | undefined
  if (raw.externalVerdictsSince !== undefined) {
    verdictsSince = new Date(raw.externalVerdictsSince)
    if (Number.isNaN(verdictsSince.getTime())) {
      throw new AppError('Invalid external verdict cursor', 400, 'INVALID_VERDICT_CURSOR')
    }
  }

  return {
    cursor: raw.cursor ?? null,
    externalVerdictsSince: verdictsSince,
    limit,
  }
}

function invalidCursor(): AppError {
  return new AppError('Invalid decision inbox cursor', 400, 'INVALID_DECISION_CURSOR')
}

function cursorSecret(): string {
  const configured = process.env.NEXTAUTH_SECRET?.trim()
  if (
    configured &&
    (process.env.NODE_ENV !== 'production' || configured.length >= 16)
  ) {
    return configured
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'NEXTAUTH_SECRET must be configured with at least 16 characters for decision inbox cursors',
    )
  }
  return 'dev-only-hire-decision-inbox-cursor-secret'
}

function cursorKey(): Buffer {
  return createHash('sha256')
    .update(`hire-decision-inbox-cursor:v${CURSOR_VERSION}\0`)
    .update(cursorSecret())
    .digest()
}

function decodeCursorPart(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw invalidCursor()
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.toString('base64url') !== value) throw invalidCursor()
  return decoded
}

function decisionInboxCursor(
  raw: string | null,
  scope: DecisionInboxCursorScope,
): HireDecisionActionInboxCursor | undefined {
  if (raw === null) return undefined
  try {
    if (!raw || raw.length > 1_024) throw invalidCursor()
    const parts = raw.split('.')
    if (parts.length !== 3 || parts.some((part) => !part)) {
      throw invalidCursor()
    }
    const iv = decodeCursorPart(parts[0])
    const ciphertext = decodeCursorPart(parts[1])
    const authTag = decodeCursorPart(parts[2])
    if (
      iv.length !== CURSOR_IV_BYTES ||
      authTag.length !== CURSOR_AUTH_TAG_BYTES ||
      ciphertext.length === 0
    ) {
      throw invalidCursor()
    }
    const decipher = createDecipheriv('aes-256-gcm', cursorKey(), iv)
    decipher.setAAD(
      Buffer.from(`hire-decision-inbox-cursor:v${CURSOR_VERSION}`),
    )
    decipher.setAuthTag(authTag)
    const payload = JSON.parse(
      Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
        'utf8',
      ),
    ) as Partial<DecisionInboxCursorPayload>
    const occurredAt = new Date(payload.occurredAt ?? '')
    const now = Date.now()
    if (
      Object.keys(payload).sort().join(',') !==
        'applicationId,externalVerdictsSince,issuedAt,jobId,kind,limit,memberId,occurredAt,resource,sourceId,v,workspaceId' ||
      payload.v !== CURSOR_VERSION ||
      payload.resource !== 'decision_action_inbox' ||
      typeof payload.issuedAt !== 'number' ||
      !Number.isFinite(payload.issuedAt) ||
      payload.issuedAt > now + CURSOR_FUTURE_SKEW_MS ||
      payload.issuedAt < now - CURSOR_MAX_AGE_MS ||
      payload.workspaceId !== scope.workspaceId ||
      payload.jobId !== scope.jobId ||
      payload.memberId !== scope.memberId ||
      payload.limit !== scope.limit ||
      payload.externalVerdictsSince !==
        (scope.externalVerdictsSince?.toISOString() ?? null) ||
      Number.isNaN(occurredAt.getTime()) ||
      !ACTION_KINDS.includes(
        payload.kind as (typeof ACTION_KINDS)[number],
      ) ||
      typeof payload.applicationId !== 'string' ||
      !OBJECT_ID.test(payload.applicationId) ||
      typeof payload.sourceId !== 'string' ||
      !OBJECT_ID.test(payload.sourceId)
    ) {
      throw invalidCursor()
    }
    return {
      occurredAt,
      kind: payload.kind as HireDecisionActionInboxCursor['kind'],
      applicationId: payload.applicationId,
      sourceId: payload.sourceId,
    }
  } catch (error) {
    if (error instanceof AppError) throw error
    throw invalidCursor()
  }
}

function encodeDecisionInboxCursor(
  cursor: HireDecisionActionInboxCursor,
  scope: DecisionInboxCursorScope,
): string {
  const payload: DecisionInboxCursorPayload = {
    v: CURSOR_VERSION,
    resource: 'decision_action_inbox',
    issuedAt: Date.now(),
    workspaceId: scope.workspaceId,
    jobId: scope.jobId,
    memberId: scope.memberId,
    limit: scope.limit,
    externalVerdictsSince: scope.externalVerdictsSince?.toISOString() ?? null,
    occurredAt: cursor.occurredAt.toISOString(),
    kind: cursor.kind,
    applicationId: cursor.applicationId,
    sourceId: cursor.sourceId,
  }
  const iv = randomBytes(CURSOR_IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', cursorKey(), iv)
  cipher.setAAD(
    Buffer.from(`hire-decision-inbox-cursor:v${CURSOR_VERSION}`),
  )
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ])
  return [
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.')
}

export const GET = composeHireApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 60, keyPrefix: 'rl:hire-decision-inbox' },
  async handler(req, { user, params }) {
    const query = decisionInboxQuery(req)
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const scope = {
      workspaceId: ctx.workspace._id.toString(),
      jobId: params.jobId,
      memberId: ctx.membership._id.toString(),
      externalVerdictsSince: query.externalVerdictsSince,
      limit: query.limit,
    }
    const inbox = await readHireDecisionActionInbox({
      workspaceId: scope.workspaceId,
      jobId: scope.jobId,
      externalVerdictsSince: scope.externalVerdictsSince,
      limit: scope.limit,
      cursor: decisionInboxCursor(query.cursor, scope),
    })
    return NextResponse.json(
      {
        items: inbox.items,
        limit: inbox.limit,
        nextCursor: inbox.nextCursor
          ? encodeDecisionInboxCursor(inbox.nextCursor, scope)
          : null,
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  },
})
