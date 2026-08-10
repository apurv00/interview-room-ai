import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { AppError } from '@shared/errors'
import { HireMemberDeletionBridgeRequestSchema } from '@shared/contracts/hireMemberDeletionBridge'
import { verifyInternalServiceRequest } from '@shared/services/internalServiceAuth'
import {
  HireWorkspaceDeletionConfirmationError,
  commitLinkedB2CAccountDeletion,
  preflightLinkedB2CAccountDeletion,
} from '@hire/services/memberLifecycleService'

export const dynamic = 'force-dynamic'
const ROUTE_PATH = '/api/internal/hire/member-account-deletion'
const MAX_BODY_BYTES = 8 * 1024

function verificationKeys() {
  const secret = process.env.HIRE_ACCOUNT_BRIDGE_SECRET
  if (!secret || secret.length < 32) return []
  return [{ keyId: process.env.HIRE_ACCOUNT_BRIDGE_KEY_ID || 'current', secret }]
}

export async function POST(req: NextRequest) {
  const body = await req.text()
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }
  const auth = await verifyInternalServiceRequest({
    method: 'POST',
    path: ROUTE_PATH,
    body,
    headers: req.headers,
    keys: verificationKeys(),
  })
  if (!auth.ok) {
    const status = auth.reason === 'replay-store-unavailable' ? 503 : 401
    return NextResponse.json({ error: 'Service authentication failed' }, { status })
  }

  try {
    const input = HireMemberDeletionBridgeRequestSchema.parse(JSON.parse(body))
    const result = input.phase === 'preflight'
      ? await preflightLinkedB2CAccountDeletion(input)
      : await commitLinkedB2CAccountDeletion(input)
    return NextResponse.json(
      {
        ok: true,
        action: result.action,
        ...('purgeAfter' in result && result.purgeAfter
          ? { purgeAfter: result.purgeAfter.toISOString() }
          : {}),
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  } catch (error) {
    if (error instanceof HireWorkspaceDeletionConfirmationError) {
      return NextResponse.json(
        {
          ok: false,
          code: error.code,
          error: error.message,
          workspaceName: error.workspaceName,
        },
        { status: 409, headers: { 'Cache-Control': 'private, no-store' } },
      )
    }
    if (error instanceof AppError) {
      const isDeletionGate =
        error.code === 'HIRE_ADMIN_TRANSFER_REQUIRED' ||
        error.code === 'HIRE_WORKSPACE_DELETE_CONFIRMATION_REQUIRED'
      return NextResponse.json(
        isDeletionGate
          ? { ok: false, code: error.code, error: error.message }
          : { error: error.message, code: error.code },
        { status: isDeletionGate ? 409 : error.statusCode },
      )
    }
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })
  }
}
