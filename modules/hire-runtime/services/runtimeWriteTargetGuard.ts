import { resolveHireRuntimeWriteTarget } from '@shared/contracts/hireRuntimeWriteFence'

const OBJECT_ID = /^[a-f0-9]{24}$/i
const RECORDING_KEY =
  /^recordings\/([a-f0-9]{24})\/([a-f0-9]{24})(?:-(screen|audio))?-\d{10,16}\.webm$/i
const MAX_VISITED_CONTAINERS = 250_000

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
  kind: 'recording' | 'screen-recording' | 'audio-recording'
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
    return
  }
  if (action === 'download') {
    const key = requiredString(body, 'key')
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
    return
  }
  if (!['sign-part', 'complete', 'abort'].includes(action)) {
    throw new RuntimeWriteTargetGuardError('Runtime multipart action was not allowed')
  }
  assertSessionField(body, binding, action === 'complete')
  const key = requiredString(body, 'key')
  const uploadId = requiredString(body, 'uploadId')
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
    assertRecordingKey(value, binding, kind)
    assertObjectCapability(value, binding, now)
  }
}

export function assertRuntimeWriteTargetBound(
  input: RuntimeWriteTargetGuardInput,
): void {
  const target = resolveHireRuntimeWriteTarget(input.pathname, input.method)
  if (!target) throw new RuntimeWriteTargetGuardError('Runtime write target was not inventoried')
  const { binding } = input
  if (
    binding.status !== 'active' ||
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
}

export const __runtimeWriteTargetGuard = {
  recordingIdentity,
}
