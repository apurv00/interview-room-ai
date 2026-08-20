import { resolveHireRuntimeWriteTarget } from '@shared/contracts/hireRuntimeWriteFence'
import { supportsHireDisplayCapture } from '@hire-multimodal-boundary'

const OBJECT_ID = /^[a-f0-9]{24}$/i
const RECORDING_KEY =
  /^recordings\/([a-f0-9]{24})\/([a-f0-9]{24})(?:-(screen|audio))?-\d{10,16}\.webm$/i
const MAX_VISITED_CONTAINERS = 250_000
const MAX_RESULT_REVISION = 10

export class RuntimeWriteTargetGuardError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 410 | 413 = 404,
  ) {
    super(message)
    this.name = 'RuntimeWriteTargetGuardError'
  }
}

export interface RuntimeWriteTargetBinding {
  bindingId: string
  status: string
  consentVersion: string
  publishedRevision?: number
  cameraMediaStatus?: 'pending' | 'published'
  screenMediaStatus?: 'pending' | 'published'
  workspaceId: string
  applicationId: string
  roundId: string
  principalId: string
  runtimeSessionId?: string
  issuedObjectCapabilities?: ReadonlyArray<{
    key: string
    runtimeSessionId: string
    expiresAt: Date | string
  }>
  issuedMultipartCapabilities?: ReadonlyArray<{
    key: string
    runtimeSessionId: string
    uploadId: string
    expiresAt: Date | string
  }>
}

type RecordingKind = 'recording' | 'screen-recording' | 'audio-recording'
type ReplayRecordingKind = Exclude<RecordingKind, 'audio-recording'>

export interface RuntimeWriteTargetGuardInput {
  pathname: string
  method: string
  bodyPresent: boolean
  requestBody: Record<string, unknown> | null
  query?: Iterable<readonly [string, string]>
  binding: RuntimeWriteTargetBinding
  now?: Date
}

type BindingCoordinate =
  | 'bindingId'
  | 'workspaceId'
  | 'applicationId'
  | 'roundId'
  | 'principalId'
  | 'runtimeSessionId'

const COORDINATE_KEYS = new Map<string, BindingCoordinate>([
  ['bindingid', 'bindingId'],
  ['binding_id', 'bindingId'],
  ['workspaceid', 'workspaceId'],
  ['workspace_id', 'workspaceId'],
  ['organizationid', 'workspaceId'],
  ['organization_id', 'workspaceId'],
  ['applicationid', 'applicationId'],
  ['application_id', 'applicationId'],
  ['roundid', 'roundId'],
  ['round_id', 'roundId'],
  ['principalid', 'principalId'],
  ['principal_id', 'principalId'],
  ['userid', 'principalId'],
  ['user_id', 'principalId'],
  ['owneruserid', 'principalId'],
  ['owner_user_id', 'principalId'],
  ['originuserid', 'principalId'],
  ['origin_user_id', 'principalId'],
  ['sessionid', 'runtimeSessionId'],
  ['session_id', 'runtimeSessionId'],
  ['interviewid', 'runtimeSessionId'],
  ['interview_id', 'runtimeSessionId'],
  ['interviewsessionid', 'runtimeSessionId'],
  ['interview_session_id', 'runtimeSessionId'],
  ['runtimesessionid', 'runtimeSessionId'],
  ['runtime_session_id', 'runtimeSessionId'],
])

// These coordinates belong to another product/control-plane aggregate and
// have no safe meaning at an unchanged-engine boundary.
const UNSUPPORTED_COORDINATE_KEYS = new Set([
  'candidateid',
  'candidate_id',
  'jobid',
  'job_id',
  'memberid',
  'member_id',
  'parentsessionid',
  'parent_session_id',
])

function sameId(actual: string, expected: string): boolean {
  return OBJECT_ID.test(actual) && actual.toLowerCase() === expected.toLowerCase()
}

function requiredString(
  body: Record<string, unknown>,
  key: string,
): string {
  const value = body[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuntimeWriteTargetGuardError('Runtime target coordinate was missing')
  }
  return value
}

function assertCoordinate(
  key: string,
  value: unknown,
  binding: RuntimeWriteTargetBinding,
): void {
  const normalizedKey = key.toLowerCase()
  if (UNSUPPORTED_COORDINATE_KEYS.has(normalizedKey)) {
    throw new RuntimeWriteTargetGuardError('Runtime target used an unsupported coordinate')
  }
  const coordinate = COORDINATE_KEYS.get(normalizedKey)
  if (!coordinate) return
  const expected = binding[coordinate]
  if (typeof value !== 'string' || typeof expected !== 'string' || !sameId(value, expected)) {
    throw new RuntimeWriteTargetGuardError('Runtime target crossed its signed binding')
  }
}

function assertAllCoordinates(
  value: unknown,
  binding: RuntimeWriteTargetBinding,
): void {
  const pending: unknown[] = [value]
  const seen = new Set<object>()
  let visited = 0

  while (pending.length > 0) {
    const current = pending.pop()
    if (!current || typeof current !== 'object') continue
    if (seen.has(current)) continue
    seen.add(current)
    visited += 1
    if (visited > MAX_VISITED_CONTAINERS) {
      throw new RuntimeWriteTargetGuardError('Runtime target body was too complex', 413)
    }
    if (Array.isArray(current)) {
      pending.push(...current)
      continue
    }
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      assertCoordinate(key, child, binding)
      if (child && typeof child === 'object') pending.push(child)
    }
  }
}

function recordingIdentity(key: string): {
  principalId: string
  runtimeSessionId: string
  kind: RecordingKind
} {
  const match = RECORDING_KEY.exec(key)
  if (!match) throw new RuntimeWriteTargetGuardError('Runtime recording key was not canonical')
  return {
    principalId: match[1],
    runtimeSessionId: match[2],
    kind: match[3] === 'screen'
      ? 'screen-recording'
      : match[3] === 'audio'
        ? 'audio-recording'
        : 'recording',
  }
}

function assertRecordingConsent(
  kind: RecordingKind,
  binding: RuntimeWriteTargetBinding,
): void {
  if (
    kind === 'screen-recording' &&
    !supportsHireDisplayCapture(binding.consentVersion)
  ) {
    throw new RuntimeWriteTargetGuardError(
      'Runtime display recording was not consented',
    )
  }
}

function assertRecordingKey(
  key: string,
  binding: RuntimeWriteTargetBinding,
  expectedKind?: string,
): void {
  const identity = recordingIdentity(key)
  if (
    !sameId(identity.principalId, binding.principalId) ||
    !binding.runtimeSessionId ||
    !sameId(identity.runtimeSessionId, binding.runtimeSessionId) ||
    (expectedKind !== undefined && identity.kind !== expectedKind)
  ) {
    throw new RuntimeWriteTargetGuardError('Runtime recording key crossed its signed binding')
  }
}

function isLiveExpiry(value: Date | string, now: Date): boolean {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) && date > now
}

function assertObjectCapability(
  key: string,
  binding: RuntimeWriteTargetBinding,
  now: Date,
): void {
  assertRecordingKey(key, binding)
  const capability = binding.issuedObjectCapabilities?.some((candidate) =>
    candidate.key === key &&
    binding.runtimeSessionId !== undefined &&
    sameId(candidate.runtimeSessionId, binding.runtimeSessionId) &&
    isLiveExpiry(candidate.expiresAt, now),
  )
  if (!capability) {
    throw new RuntimeWriteTargetGuardError('Runtime object capability was not issued by this binding')
  }
}

function assertMultipartCapability(
  key: string,
  uploadId: string,
  binding: RuntimeWriteTargetBinding,
  now: Date,
): void {
  assertRecordingKey(key, binding)
  const capability = binding.issuedMultipartCapabilities?.some((candidate) =>
    candidate.key === key &&
    candidate.uploadId === uploadId &&
    binding.runtimeSessionId !== undefined &&
    sameId(candidate.runtimeSessionId, binding.runtimeSessionId) &&
    isLiveExpiry(candidate.expiresAt, now),
  )
  if (!capability) {
    throw new RuntimeWriteTargetGuardError('Runtime multipart capability was not issued by this binding')
  }
}

function assertSessionField(
  body: Record<string, unknown>,
  binding: RuntimeWriteTargetBinding,
  required: boolean,
): void {
  const sessionId = body.sessionId
  if (sessionId === undefined && !required) return
  if (
    typeof sessionId !== 'string' ||
    !binding.runtimeSessionId ||
    !sameId(sessionId, binding.runtimeSessionId)
  ) {
    throw new RuntimeWriteTargetGuardError('Runtime session coordinate crossed its binding')
  }
}

function assertRecordingArtifact(
  body: Record<string, unknown>,
  binding: RuntimeWriteTargetBinding,
  now: Date,
): void {
  assertSessionField(body, binding, true)
  const key = requiredString(body, 'key')
  const type = requiredString(body, 'type')
  if (!['recording', 'screen-recording', 'audio-recording'].includes(type)) {
    throw new RuntimeWriteTargetGuardError('Runtime recording type was not allowed')
  }
  assertRecordingConsent(type as RecordingKind, binding)
  assertRecordingKey(key, binding, type)
  assertObjectCapability(key, binding, now)
}

function assertPresign(
  body: Record<string, unknown>,
  binding: RuntimeWriteTargetBinding,
  now: Date,
): void {
  const action = requiredString(body, 'action')
  if (action === 'upload') {
    assertSessionField(body, binding, true)
    const type = requiredString(body, 'type')
    if (!['recording', 'screen-recording', 'audio-recording'].includes(type) || body.key !== undefined) {
      throw new RuntimeWriteTargetGuardError('Runtime presign shape was not allowed')
    }
    assertRecordingConsent(type as RecordingKind, binding)
    return
  }
  if (action === 'download') {
    const key = requiredString(body, 'key')
    assertRecordingConsent(recordingIdentity(key).kind, binding)
    assertObjectCapability(key, binding, now)
    return
  }
  throw new RuntimeWriteTargetGuardError('Runtime presign action was not allowed')
}

function assertMultipart(
  body: Record<string, unknown>,
  binding: RuntimeWriteTargetBinding,
  now: Date,
): void {
  const action = requiredString(body, 'action')
  if (action === 'create') {
    assertSessionField(body, binding, true)
    const type = requiredString(body, 'type')
    if (
      !['recording', 'screen-recording', 'audio-recording'].includes(type) ||
      body.key !== undefined ||
      body.uploadId !== undefined
    ) {
      throw new RuntimeWriteTargetGuardError('Runtime multipart create shape was not allowed')
    }
    assertRecordingConsent(type as RecordingKind, binding)
    return
  }
  if (!['sign-part', 'complete', 'abort'].includes(action)) {
    throw new RuntimeWriteTargetGuardError('Runtime multipart action was not allowed')
  }
  assertSessionField(body, binding, action === 'complete')
  const key = requiredString(body, 'key')
  const uploadId = requiredString(body, 'uploadId')
  if (action !== 'abort') {
    assertRecordingConsent(recordingIdentity(key).kind, binding)
  }
  assertMultipartCapability(key, uploadId, binding, now)
  if (typeof body.type === 'string') assertRecordingKey(key, binding, body.type)
}

function assertLegacyPathRecordingKeys(
  body: Record<string, unknown>,
  binding: RuntimeWriteTargetBinding,
  now: Date,
): void {
  const keys: ReadonlyArray<readonly [string, string]> = [
    ['recordingR2Key', 'recording'],
    ['screenRecordingR2Key', 'screen-recording'],
    ['audioRecordingR2Key', 'audio-recording'],
  ]
  for (const [field, kind] of keys) {
    const value = body[field]
    if (value === undefined) continue
    if (typeof value !== 'string') {
      throw new RuntimeWriteTargetGuardError('Runtime recording coordinate was invalid')
    }
    assertRecordingConsent(kind as RecordingKind, binding)
    assertRecordingKey(value, binding, kind)
    assertObjectCapability(value, binding, now)
  }
}

function assertPendingReplayKind(
  kind: ReplayRecordingKind,
  binding: RuntimeWriteTargetBinding,
): void {
  const pending = kind === 'recording'
    ? binding.cameraMediaStatus === 'pending'
    : binding.screenMediaStatus === 'pending' &&
      supportsHireDisplayCapture(binding.consentVersion)
  if (!pending) {
    throw new RuntimeWriteTargetGuardError(
      'Runtime replay upload is no longer pending',
      410,
    )
  }
}

function replayKindFromBodyType(
  body: Record<string, unknown>,
): ReplayRecordingKind {
  const type = requiredString(body, 'type')
  if (type !== 'recording' && type !== 'screen-recording') {
    throw new RuntimeWriteTargetGuardError(
      'Runtime post-result write was not a replay upload',
      410,
    )
  }
  return type
}

function assertPostResultReplayWrite(
  input: RuntimeWriteTargetGuardInput,
  target: NonNullable<ReturnType<typeof resolveHireRuntimeWriteTarget>>,
): void {
  const { binding } = input
  if (binding.publishedRevision === undefined) return
  if (
    !Number.isInteger(binding.publishedRevision) ||
    binding.publishedRevision < 1 ||
    binding.publishedRevision >= MAX_RESULT_REVISION
  ) {
    throw new RuntimeWriteTargetGuardError(
      'Runtime replay publication window is closed',
      410,
    )
  }
  const body = input.requestBody ?? {}

  switch (target.coordinates) {
    case 'recording-artifact':
      assertPendingReplayKind(replayKindFromBodyType(body), binding)
      return
    case 'storage-presign':
      if (body.action !== 'upload') break
      assertPendingReplayKind(replayKindFromBodyType(body), binding)
      return
    case 'storage-multipart': {
      if (body.action === 'abort') return
      if (body.action === 'create') {
        assertPendingReplayKind(replayKindFromBodyType(body), binding)
        return
      }
      const key = requiredString(body, 'key')
      const kind = recordingIdentity(key).kind
      if (kind === 'audio-recording') break
      assertPendingReplayKind(kind, binding)
      return
    }
    default:
      break
  }

  throw new RuntimeWriteTargetGuardError(
    'Runtime interview writes are closed after result publication',
    410,
  )
}

export function assertRuntimeWriteTargetBound(
  input: RuntimeWriteTargetGuardInput,
): void {
  const target = resolveHireRuntimeWriteTarget(input.pathname, input.method)
  if (!target) throw new RuntimeWriteTargetGuardError('Runtime write target was not inventoried')
  const { binding } = input
  const completedReplay =
    binding.status === 'completed' &&
    binding.publishedRevision !== undefined &&
    Number.isInteger(binding.publishedRevision) &&
    binding.publishedRevision >= 1 &&
    binding.publishedRevision < MAX_RESULT_REVISION
  if (
    (binding.status !== 'active' && !completedReplay) ||
    !binding.runtimeSessionId ||
    !sameId(binding.runtimeSessionId, binding.runtimeSessionId)
  ) {
    throw new RuntimeWriteTargetGuardError('Runtime binding has no active session', 410)
  }
  if (target.body === 'required-object' && (!input.bodyPresent || !input.requestBody)) {
    throw new RuntimeWriteTargetGuardError('Runtime target body was missing')
  }
  if (input.bodyPresent && !input.requestBody) {
    throw new RuntimeWriteTargetGuardError('Runtime target body was not a JSON object')
  }

  const body = input.requestBody ?? {}
  assertAllCoordinates(body, binding)
  if (input.query) {
    for (const [key, value] of Array.from(input.query)) {
      assertCoordinate(key, value, binding)
    }
  }

  const now = input.now ?? new Date()
  switch (target.coordinates) {
    case 'path-session':
      if (!target.pathSessionId || !sameId(target.pathSessionId, binding.runtimeSessionId)) {
        throw new RuntimeWriteTargetGuardError('Runtime path crossed its signed session')
      }
      assertLegacyPathRecordingKeys(body, binding, now)
      break
    case 'required-session':
      assertSessionField(body, binding, true)
      break
    case 'recording-artifact':
      assertRecordingArtifact(body, binding, now)
      break
    case 'storage-presign':
      assertPresign(body, binding, now)
      break
    case 'storage-multipart':
      assertMultipart(body, binding, now)
      break
    case 'none':
      break
  }
  assertPostResultReplayWrite(input, target)
}

export const __runtimeWriteTargetGuard = {
  recordingIdentity,
}
