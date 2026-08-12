/** Edge-safe route contract shared by runtime middleware and the Node proxy. */
export const HIRE_RUNTIME_WRITE_DRAIN_MS = 6 * 60 * 1_000
export const HIRE_RUNTIME_STORAGE_CAPABILITY_MS = 66 * 60 * 1_000

export type HireRuntimeCoordinatePolicy =
  | 'none'
  | 'required-session'
  | 'recording-artifact'
  | 'storage-presign'
  | 'storage-multipart'

export interface HireRuntimeExactWriteTarget {
  readonly pathname: string
  readonly methods: readonly string[]
  readonly coordinates: HireRuntimeCoordinatePolicy
  /** Exact authority-bearing request coordinates consumed by this route. */
  readonly guardedCoordinates: readonly string[]
  /** Every route except the token endpoint consumes a JSON object. */
  readonly body: 'required-object' | 'optional-object'
  readonly storageCapability?: true
}

/**
 * Complete inventory of unchanged-engine writes reachable from the isolated
 * Hire runtime. Coordinate policy is enforced again by the Node write-fence;
 * this Edge-safe list only decides whether middleware may route a request to it.
 */
export const HIRE_RUNTIME_EXACT_WRITE_TARGETS = [
  { pathname: '/api/generate-question', methods: ['POST'], coordinates: 'required-session', guardedCoordinates: ['sessionId', 'config.attribution.applicationId', 'config.attribution.jobId'], body: 'required-object' },
  { pathname: '/api/evaluate-answer', methods: ['POST'], coordinates: 'required-session', guardedCoordinates: ['sessionId', 'config.attribution.applicationId', 'config.attribution.jobId'], body: 'required-object' },
  { pathname: '/api/evaluate-code', methods: ['POST'], coordinates: 'required-session', guardedCoordinates: ['sessionId'], body: 'required-object' },
  { pathname: '/api/evaluate-design', methods: ['POST'], coordinates: 'required-session', guardedCoordinates: ['sessionId'], body: 'required-object' },
  { pathname: '/api/generate-feedback', methods: ['POST'], coordinates: 'required-session', guardedCoordinates: ['sessionId', 'config.attribution.applicationId', 'config.attribution.jobId'], body: 'required-object' },
  { pathname: '/api/code/generate-problem', methods: ['POST'], coordinates: 'none', guardedCoordinates: [], body: 'required-object' },
  { pathname: '/api/code/run', methods: ['POST'], coordinates: 'none', guardedCoordinates: [], body: 'required-object' },
  { pathname: '/api/problems/served', methods: ['POST'], coordinates: 'none', guardedCoordinates: [], body: 'required-object' },
  { pathname: '/api/design/generate-problem', methods: ['POST'], coordinates: 'none', guardedCoordinates: [], body: 'required-object' },
  { pathname: '/api/interview/answer-candidate-question', methods: ['POST'], coordinates: 'required-session', guardedCoordinates: ['sessionId', 'config.attribution.applicationId', 'config.attribution.jobId'], body: 'required-object' },
  { pathname: '/api/interview/clarify-case-context', methods: ['POST'], coordinates: 'required-session', guardedCoordinates: ['sessionId', 'config.attribution.applicationId', 'config.attribution.jobId'], body: 'required-object' },
  { pathname: '/api/interview/clarify-coding', methods: ['POST'], coordinates: 'required-session', guardedCoordinates: ['sessionId'], body: 'required-object' },
  { pathname: '/api/transcribe/token', methods: ['POST'], coordinates: 'none', guardedCoordinates: [], body: 'optional-object' },
  { pathname: '/api/turn-router', methods: ['POST'], coordinates: 'none', guardedCoordinates: [], body: 'required-object' },
  { pathname: '/api/tts', methods: ['POST'], coordinates: 'none', guardedCoordinates: [], body: 'required-object' },
  { pathname: '/api/tts/stream', methods: ['POST'], coordinates: 'none', guardedCoordinates: [], body: 'required-object' },
  { pathname: '/api/recordings/finalize', methods: ['POST'], coordinates: 'recording-artifact', guardedCoordinates: ['sessionId', 'key', 'x-origin-user-id'], body: 'required-object' },
  { pathname: '/api/recordings/landmarks', methods: ['POST'], coordinates: 'required-session', guardedCoordinates: ['sessionId', 'x-origin-user-id'], body: 'required-object' },
  { pathname: '/api/storage/presign', methods: ['POST'], coordinates: 'storage-presign', guardedCoordinates: ['sessionId', 'key', 'x-origin-user-id'], body: 'required-object', storageCapability: true },
  { pathname: '/api/storage/multipart', methods: ['POST'], coordinates: 'storage-multipart', guardedCoordinates: ['sessionId', 'key', 'uploadId', 'x-origin-user-id'], body: 'required-object', storageCapability: true },
  { pathname: '/api/debug/deepgram-ws-close', methods: ['POST'], coordinates: 'none', guardedCoordinates: [], body: 'required-object' },
] as const satisfies readonly HireRuntimeExactWriteTarget[]

export interface ResolvedHireRuntimeWriteTarget {
  readonly pathname: string
  readonly method: string
  readonly coordinates: HireRuntimeCoordinatePolicy | 'path-session'
  readonly guardedCoordinates: readonly string[]
  readonly body: 'required-object' | 'optional-object'
  readonly drainMs: number
  readonly pathSessionId?: string
}

const FENCED_EXACT_WRITES = new Map<string, HireRuntimeExactWriteTarget>(
  HIRE_RUNTIME_EXACT_WRITE_TARGETS.map((target) => [target.pathname, target]),
)

export function resolveHireRuntimeWriteTarget(
  pathname: string,
  method: string,
): ResolvedHireRuntimeWriteTarget | null {
  const normalizedMethod = method.toUpperCase()
  const pathMatch = /^\/api\/interviews\/([a-f0-9]{24})$/i.exec(pathname)
  if (pathMatch && normalizedMethod === 'PATCH') {
    return {
      pathname,
      method: normalizedMethod,
      coordinates: 'path-session',
      guardedCoordinates: ['path.id', 'recordingR2Key', 'screenRecordingR2Key', 'audioRecordingR2Key', 'x-origin-user-id'],
      body: 'required-object',
      drainMs: HIRE_RUNTIME_WRITE_DRAIN_MS,
      pathSessionId: pathMatch[1],
    }
  }

  const target = FENCED_EXACT_WRITES.get(pathname)
  if (!target?.methods.includes(normalizedMethod)) return null
  return {
    pathname,
    method: normalizedMethod,
    coordinates: target.coordinates,
    guardedCoordinates: target.guardedCoordinates,
    body: target.body,
    drainMs: target.storageCapability
      ? HIRE_RUNTIME_STORAGE_CAPABILITY_MS
      : HIRE_RUNTIME_WRITE_DRAIN_MS,
  }
}

export function runtimeWriteDrainMs(pathname: string, method: string): number | null {
  return resolveHireRuntimeWriteTarget(pathname, method)?.drainMs ?? null
}
