import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto'
import { AppError } from '@shared/errors'
import {
  SCREENING_PREVIEW_PAGE_SIZE,
  type ScreeningPreviewPageScope,
} from './serialize'

const CURSOR_VERSION = 1
const CURSOR_IV_BYTES = 12
const CURSOR_AUTH_TAG_BYTES = 16
const CURSOR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000
const CURSOR_FUTURE_SKEW_MS = 60_000
const OBJECT_ID = /^[a-f0-9]{24}$/i
const FINGERPRINT = /^[a-f0-9]{64}$/i

type CursorScope = {
  workspaceId: string
  jobId: string
  memberId: string
}

type PreviewCursorPayload = CursorScope & {
  v: 1
  kind: 'preview'
  issuedAt: number
  fingerprint: string
  scope: ScreeningPreviewPageScope
  offset: number
}

export type ScreeningHistoryCursor = {
  confirmedAt: Date
  id: string
}

type HistoryCursorPayload = CursorScope & {
  v: 1
  kind: 'history'
  issuedAt: number
  limit: number
  confirmedAt: string
  id: string
}

export type ScreeningBatchCursor = { wave: number; id: string }

type BatchCursorPayload = CursorScope & {
  v: 1
  kind: 'batches'
  issuedAt: number
  gateId: string
  limit: number
  wave: number
  id: string
}

function cursorSecret(): string {
  const configured = process.env.NEXTAUTH_SECRET?.trim()
  if (
    configured &&
    (process.env.NODE_ENV !== 'production' || configured.length >= 16)
  ) return configured
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'NEXTAUTH_SECRET must be configured with at least 16 characters for screening cursors',
    )
  }
  return 'dev-only-hire-screening-cursor-secret'
}

function cursorKey(): Buffer {
  return createHash('sha256')
    .update(`hire-screening-cursor:v${CURSOR_VERSION}\0`)
    .update(cursorSecret())
    .digest()
}

function invalidCursor(): AppError {
  return new AppError('Invalid screening cursor', 400, 'INVALID_SCREENING_CURSOR')
}

function stalePreview(): AppError {
  return new AppError(
    'The ranked queue changed — refresh the screening preview',
    409,
    'SCREENING_PREVIEW_STALE',
  )
}

function decodePart(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw invalidCursor()
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.toString('base64url') !== value) throw invalidCursor()
  return decoded
}

function encodeCursor(
  payload: PreviewCursorPayload | HistoryCursorPayload | BatchCursorPayload,
): string {
  const iv = randomBytes(CURSOR_IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', cursorKey(), iv)
  cipher.setAAD(Buffer.from(`hire-screening-cursor:v${CURSOR_VERSION}`))
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

function decodeCursor(value: string): Record<string, unknown> {
  try {
    if (!value || value.length > 2_048) throw invalidCursor()
    const parts = value.split('.')
    if (parts.length !== 3 || parts.some((part) => !part)) throw invalidCursor()
    const iv = decodePart(parts[0])
    const ciphertext = decodePart(parts[1])
    const authTag = decodePart(parts[2])
    if (
      iv.length !== CURSOR_IV_BYTES ||
      authTag.length !== CURSOR_AUTH_TAG_BYTES ||
      ciphertext.length === 0
    ) throw invalidCursor()
    const decipher = createDecipheriv('aes-256-gcm', cursorKey(), iv)
    decipher.setAAD(Buffer.from(`hire-screening-cursor:v${CURSOR_VERSION}`))
    decipher.setAuthTag(authTag)
    const decoded = JSON.parse(
      Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'),
    )
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw invalidCursor()
    }
    return decoded as Record<string, unknown>
  } catch (error) {
    if (error instanceof AppError) throw error
    throw invalidCursor()
  }
}

function validIssuedAt(value: unknown): value is number {
  const now = Date.now()
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value <= now + CURSOR_FUTURE_SKEW_MS &&
    value >= now - CURSOR_MAX_AGE_MS
  )
}

export function screeningPreviewPageOffset(input: CursorScope & {
  scope: ScreeningPreviewPageScope
  cursor?: string
  expectedFingerprint?: string
  currentFingerprint: string
}): number {
  if (
    input.expectedFingerprint !== undefined &&
    input.expectedFingerprint !== input.currentFingerprint
  ) throw stalePreview()
  if (!input.cursor) return 0
  const payload = decodeCursor(input.cursor)
  if (
    Object.keys(payload).sort().join(',') !==
      'fingerprint,issuedAt,jobId,kind,memberId,offset,scope,v,workspaceId' ||
    payload.v !== CURSOR_VERSION ||
    payload.kind !== 'preview' ||
    !validIssuedAt(payload.issuedAt) ||
    payload.workspaceId !== input.workspaceId ||
    payload.jobId !== input.jobId ||
    payload.memberId !== input.memberId ||
    payload.scope !== input.scope ||
    typeof payload.fingerprint !== 'string' ||
    !FINGERPRINT.test(payload.fingerprint) ||
    typeof payload.offset !== 'number' ||
    !Number.isSafeInteger(payload.offset) ||
    payload.offset < 0 ||
    payload.offset % SCREENING_PREVIEW_PAGE_SIZE !== 0
  ) throw invalidCursor()
  if (payload.fingerprint !== input.currentFingerprint) throw stalePreview()
  return payload.offset
}

export function encodeScreeningPreviewPageCursor(input: CursorScope & {
  fingerprint: string
  scope: ScreeningPreviewPageScope
  offset: number
}): string {
  return encodeCursor({
    v: CURSOR_VERSION,
    kind: 'preview',
    issuedAt: Date.now(),
    workspaceId: input.workspaceId,
    jobId: input.jobId,
    memberId: input.memberId,
    fingerprint: input.fingerprint,
    scope: input.scope,
    offset: input.offset,
  })
}

export function decodeScreeningHistoryCursor(
  value: string | null,
  scope: CursorScope,
  limit: number,
): ScreeningHistoryCursor | undefined {
  if (value === null) return undefined
  const payload = decodeCursor(value)
  const confirmedAt = new Date(
    typeof payload.confirmedAt === 'string' ? payload.confirmedAt : '',
  )
  if (
    Object.keys(payload).sort().join(',') !==
      'confirmedAt,id,issuedAt,jobId,kind,limit,memberId,v,workspaceId' ||
    payload.v !== CURSOR_VERSION ||
    payload.kind !== 'history' ||
    !validIssuedAt(payload.issuedAt) ||
    payload.workspaceId !== scope.workspaceId ||
    payload.jobId !== scope.jobId ||
    payload.memberId !== scope.memberId ||
    payload.limit !== limit ||
    typeof payload.id !== 'string' ||
    !OBJECT_ID.test(payload.id) ||
    Number.isNaN(confirmedAt.getTime())
  ) throw invalidCursor()
  return { confirmedAt, id: payload.id }
}

export function encodeScreeningHistoryCursor(
  cursor: ScreeningHistoryCursor,
  scope: CursorScope,
  limit: number,
): string {
  return encodeCursor({
    v: CURSOR_VERSION,
    kind: 'history',
    issuedAt: Date.now(),
    ...scope,
    limit,
    confirmedAt: cursor.confirmedAt.toISOString(),
    id: cursor.id,
  })
}

export function decodeScreeningBatchCursor(
  value: string | null,
  scope: CursorScope & { gateId: string },
  limit: number,
): ScreeningBatchCursor | undefined {
  if (value === null) return undefined
  const payload = decodeCursor(value)
  if (
    Object.keys(payload).sort().join(',') !==
      'gateId,id,issuedAt,jobId,kind,limit,memberId,v,wave,workspaceId' ||
    payload.v !== CURSOR_VERSION ||
    payload.kind !== 'batches' ||
    !validIssuedAt(payload.issuedAt) ||
    payload.workspaceId !== scope.workspaceId ||
    payload.jobId !== scope.jobId ||
    payload.memberId !== scope.memberId ||
    payload.gateId !== scope.gateId ||
    payload.limit !== limit ||
    typeof payload.wave !== 'number' ||
    !Number.isInteger(payload.wave) ||
    payload.wave < 1 ||
    typeof payload.id !== 'string' ||
    !OBJECT_ID.test(payload.id)
  ) throw invalidCursor()
  return { wave: payload.wave, id: payload.id }
}

export function encodeScreeningBatchCursor(
  cursor: ScreeningBatchCursor,
  scope: CursorScope & { gateId: string },
  limit: number,
): string {
  return encodeCursor({
    v: CURSOR_VERSION,
    kind: 'batches',
    issuedAt: Date.now(),
    ...scope,
    limit,
    wave: cursor.wave,
    id: cursor.id,
  })
}
