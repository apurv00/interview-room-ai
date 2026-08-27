import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto'
import { AppError } from '@shared/errors'

const VERSION = 1
const IV_BYTES = 12
const AUTH_TAG_BYTES = 16
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000
const FUTURE_SKEW_MS = 60_000
const OBJECT_ID = /^[a-f0-9]{24}$/i
const FILTER = 'conflict_failed_unredacted_v1'

export interface BulkOperationIssueCursorScope {
  workspaceId: string
  jobId: string
  operationId: string
  memberId: string
  limit: number
}

type CursorPayload = BulkOperationIssueCursorScope & {
  v: 1
  kind: 'bulk_issues'
  issuedAt: number
  filter: typeof FILTER
  itemId: string
}

function invalidCursor(): AppError {
  return new AppError(
    'Invalid candidate bulk operation issue cursor',
    400,
    'BULK_OPERATION_INVALID_CURSOR',
  )
}

function cursorSecret(): string {
  const configured = process.env.NEXTAUTH_SECRET?.trim()
  if (
    configured &&
    (process.env.NODE_ENV !== 'production' || configured.length >= 16)
  ) return configured
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'NEXTAUTH_SECRET must be configured with at least 16 characters for candidate bulk issue cursors',
    )
  }
  return 'dev-only-hire-candidate-bulk-issue-cursor-secret'
}

function cursorKey(): Buffer {
  return createHash('sha256')
    .update(`hire-candidate-bulk-issues:v${VERSION}\0`)
    .update(cursorSecret())
    .digest()
}

function decodePart(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw invalidCursor()
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.toString('base64url') !== value) throw invalidCursor()
  return decoded
}

function decodePayload(value: string): Record<string, unknown> {
  try {
    if (!value || value.length > 2_048) throw invalidCursor()
    const parts = value.split('.')
    if (parts.length !== 3 || parts.some((part) => !part)) throw invalidCursor()
    const iv = decodePart(parts[0])
    const ciphertext = decodePart(parts[1])
    const authTag = decodePart(parts[2])
    if (
      iv.length !== IV_BYTES ||
      authTag.length !== AUTH_TAG_BYTES ||
      ciphertext.length === 0
    ) throw invalidCursor()
    const decipher = createDecipheriv('aes-256-gcm', cursorKey(), iv)
    decipher.setAAD(Buffer.from(`hire-candidate-bulk-issues:v${VERSION}`))
    decipher.setAuthTag(authTag)
    const parsed = JSON.parse(
      Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
        'utf8',
      ),
    )
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw invalidCursor()
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof AppError) throw error
    throw invalidCursor()
  }
}

export function decodeBulkOperationIssueCursor(
  value: string | undefined,
  scope: BulkOperationIssueCursorScope,
): string | undefined {
  if (value === undefined) return undefined
  const payload = decodePayload(value)
  const now = Date.now()
  if (
    Object.keys(payload).sort().join(',') !==
      'filter,issuedAt,itemId,jobId,kind,limit,memberId,operationId,v,workspaceId' ||
    payload.v !== VERSION ||
    payload.kind !== 'bulk_issues' ||
    payload.filter !== FILTER ||
    typeof payload.issuedAt !== 'number' ||
    !Number.isFinite(payload.issuedAt) ||
    payload.issuedAt > now + FUTURE_SKEW_MS ||
    payload.issuedAt < now - MAX_AGE_MS ||
    payload.workspaceId !== scope.workspaceId ||
    payload.jobId !== scope.jobId ||
    payload.operationId !== scope.operationId ||
    payload.memberId !== scope.memberId ||
    payload.limit !== scope.limit ||
    typeof payload.itemId !== 'string' ||
    !OBJECT_ID.test(payload.itemId)
  ) throw invalidCursor()
  return payload.itemId
}

export function encodeBulkOperationIssueCursor(
  itemId: string,
  scope: BulkOperationIssueCursorScope,
): string {
  if (!OBJECT_ID.test(itemId)) throw invalidCursor()
  const payload: CursorPayload = {
    v: VERSION,
    kind: 'bulk_issues',
    issuedAt: Date.now(),
    filter: FILTER,
    ...scope,
    itemId,
  }
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', cursorKey(), iv)
  cipher.setAAD(Buffer.from(`hire-candidate-bulk-issues:v${VERSION}`))
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
