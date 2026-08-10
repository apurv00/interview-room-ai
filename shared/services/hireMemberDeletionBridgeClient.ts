import { randomUUID } from 'node:crypto'
import {
  HIRE_MEMBER_DELETION_BRIDGE_SCHEMA_VERSION,
  HireMemberDeletionBridgeBlockedSchema,
  HireMemberDeletionBridgeSuccessSchema,
  type HireMemberDeletionBridgeSuccess,
} from '@shared/contracts/hireMemberDeletionBridge'
import { createInternalServiceHeaders } from './internalServiceAuth'

const ROUTE_PATH = '/api/internal/hire/member-account-deletion'

export interface PrepareHireMemberDeletionInput {
  operationId: string
  workspaceConfirmationName?: string
  acknowledgeWorkspaceDeletion?: boolean
}

export class HireMemberDeletionBlockedError extends Error {
  constructor(
    public readonly code:
      | 'HIRE_ADMIN_TRANSFER_REQUIRED'
      | 'HIRE_WORKSPACE_DELETE_CONFIRMATION_REQUIRED',
    message: string,
    public readonly workspaceName?: string,
  ) {
    super(message)
    this.name = 'HireMemberDeletionBlockedError'
  }
}

export class HireMemberDeletionBridgeUnavailableError extends Error {
  constructor(message = 'Hiring workspace deletion preflight is unavailable') {
    super(message)
    this.name = 'HireMemberDeletionBridgeUnavailableError'
  }
}

function bridgeConfiguration(): {
  endpoint: URL
  key: { keyId: string; secret: string }
} | null {
  const base = process.env.HIRE_CONTROL_INTERNAL_URL
  const secret = process.env.HIRE_ACCOUNT_BRIDGE_SECRET
  const keyId = process.env.HIRE_ACCOUNT_BRIDGE_KEY_ID || 'current'
  if (!base || !secret || secret.length < 32) {
    if (process.env.NODE_ENV === 'production') {
      throw new HireMemberDeletionBridgeUnavailableError(
        'Hiring workspace deletion preflight is not configured',
      )
    }
    return null
  }
  let endpoint: URL
  try {
    endpoint = new URL(ROUTE_PATH, base)
  } catch {
    throw new HireMemberDeletionBridgeUnavailableError(
      'Hiring workspace deletion preflight URL is invalid',
    )
  }
  if (process.env.NODE_ENV === 'production' && endpoint.protocol !== 'https:') {
    throw new HireMemberDeletionBridgeUnavailableError(
      'Hiring workspace deletion preflight must use HTTPS',
    )
  }
  return { endpoint, key: { keyId, secret } }
}

/**
 * B2C → Hire control callout made before the first B2C deletion mutation.
 * Only the opaque B2C user id crosses the seam; no email is sent or queried.
 */
async function callHireMemberDeletionBridge(
  b2cUserId: string,
  phase: 'preflight' | 'commit',
  input: PrepareHireMemberDeletionInput,
): Promise<HireMemberDeletionBridgeSuccess> {
  const config = bridgeConfiguration()
  if (!config) return { ok: true, action: 'not_linked' }

  const body = JSON.stringify({
    schemaVersion: HIRE_MEMBER_DELETION_BRIDGE_SCHEMA_VERSION,
    phase,
    b2cUserId,
    operationId: input.operationId,
    ...(input.workspaceConfirmationName
      ? { workspaceConfirmationName: input.workspaceConfirmationName }
      : {}),
    ...(input.acknowledgeWorkspaceDeletion !== undefined
      ? { acknowledgeWorkspaceDeletion: input.acknowledgeWorkspaceDeletion }
      : {}),
  })
  const headers = createInternalServiceHeaders({
    method: 'POST',
    path: ROUTE_PATH,
    body,
    key: config.key,
  })

  let response: Response
  try {
    response = await fetch(config.endpoint, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body,
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(8_000),
    })
  } catch (error) {
    throw new HireMemberDeletionBridgeUnavailableError(
      error instanceof Error ? error.message : undefined,
    )
  }

  const payload: unknown = await response.json().catch(() => null)
  if (response.status === 409) {
    const blocked = HireMemberDeletionBridgeBlockedSchema.safeParse(payload)
    if (!blocked.success) throw new HireMemberDeletionBridgeUnavailableError()
    throw new HireMemberDeletionBlockedError(
      blocked.data.code,
      blocked.data.error,
      blocked.data.workspaceName,
    )
  }
  if (!response.ok) throw new HireMemberDeletionBridgeUnavailableError()
  const success = HireMemberDeletionBridgeSuccessSchema.safeParse(payload)
  if (!success.success) throw new HireMemberDeletionBridgeUnavailableError()
  return success.data
}

export async function preflightHireMemberForB2CAccountDeletion(
  b2cUserId: string,
  input: Omit<PrepareHireMemberDeletionInput, 'operationId'> & { operationId?: string } = {},
): Promise<{ operationId: string; result: HireMemberDeletionBridgeSuccess }> {
  const operationId = input.operationId ?? randomUUID()
  const result = await callHireMemberDeletionBridge(b2cUserId, 'preflight', {
    ...input,
    operationId,
  })
  return { operationId, result }
}

export async function commitHireMemberForB2CAccountDeletion(
  b2cUserId: string,
  input: PrepareHireMemberDeletionInput,
): Promise<HireMemberDeletionBridgeSuccess> {
  return callHireMemberDeletionBridge(b2cUserId, 'commit', input)
}

export const __hireMemberDeletionBridgeClient = { ROUTE_PATH }
