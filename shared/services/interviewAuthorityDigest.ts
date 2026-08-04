import { createHmac } from 'node:crypto'

/**
 * This version is part of the durable PR8 authority contract. Changing it
 * requires a separately named key and an explicit persisted-data migration.
 */
export const INTERVIEW_AUTHORITY_DIGEST_VERSION = 'v1' as const
export const INTERVIEW_AUTHORITY_DIGEST_SECRET_ENV =
  'PR8_INTERVIEW_AUTHORITY_HMAC_V1_SECRET_BASE64' as const

export const INTERVIEW_AUTHORITY_DIGEST_DOMAINS = Object.freeze({
  selfServeCreationRequest:
    'self-serve-creation-request',
  authoritativeConfig:
    'authoritative-config',
  verifiedInviteProvenance:
    'verified-invite-provenance',
  authoritativeOperationRequest:
    'authoritative-operation-request',
  authoritativeParentBinding:
    'authoritative-parent-binding',
  sessionStartRequest:
    'session-start-request',
  terminalRequest:
    'terminal-request',
} as const)

export type InterviewAuthorityDigestDomain =
  (typeof INTERVIEW_AUTHORITY_DIGEST_DOMAINS)[
    keyof typeof INTERVIEW_AUTHORITY_DIGEST_DOMAINS
  ]

export interface InterviewAuthorityDigestTestDependencies {
  /**
   * Explicit unit-test injection. Runtime callers must use the dedicated
   * environment key; production overrides are rejected.
   */
  secretBase64ForTest?: string
}

export class InterviewAuthorityDigestError extends Error {
  constructor() {
    super('Interview authority digest is unavailable')
    this.name = 'InterviewAuthorityDigestError'
  }
}

const CONTRACT_PREFIX =
  `interviewprepguru:pr8-authority-digest:${INTERVIEW_AUTHORITY_DIGEST_VERSION}`
const MAX_CANONICAL_BYTES = 256 * 1024
const MAX_SECRET_BASE64_LENGTH = 4_096
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const DOMAIN_SET = new Set<InterviewAuthorityDigestDomain>(
  Object.values(INTERVIEW_AUTHORITY_DIGEST_DOMAINS),
)

function canonicalValue(
  value: unknown,
  seen: Set<object>,
  depth: number,
): unknown {
  if (depth > 20) throw new InterviewAuthorityDigestError()
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new InterviewAuthorityDigestError()
    }
    return value
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw new InterviewAuthorityDigestError()
    }
    return value.toISOString()
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new InterviewAuthorityDigestError()
    }
    seen.add(value)
    try {
      return value.map((entry) => {
        if (entry === undefined) {
          throw new InterviewAuthorityDigestError()
        }
        return canonicalValue(entry, seen, depth + 1)
      })
    } finally {
      seen.delete(value)
    }
  }
  if (
    !value ||
    typeof value !== 'object' ||
    (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) ||
    seen.has(value)
  ) {
    throw new InterviewAuthorityDigestError()
  }

  seen.add(value)
  try {
    const source = value as Record<string, unknown>
    const canonical: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      const entry = source[key]
      if (entry !== undefined) {
        canonical[key] = canonicalValue(
          entry,
          seen,
          depth + 1,
        )
      }
    }
    return canonical
  } finally {
    seen.delete(value)
  }
}

function canonicalJson(value: unknown): string {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(
      canonicalValue(value, new Set(), 0),
    )
  } catch {
    throw new InterviewAuthorityDigestError()
  }
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, 'utf8') >
      MAX_CANONICAL_BYTES
  ) {
    throw new InterviewAuthorityDigestError()
  }
  return serialized
}

function configuredSecret(
  dependencies: InterviewAuthorityDigestTestDependencies,
): Buffer {
  if (
    dependencies.secretBase64ForTest !== undefined &&
    process.env.NODE_ENV !== 'test'
  ) {
    throw new InterviewAuthorityDigestError()
  }
  const encoded =
    dependencies.secretBase64ForTest ??
    process.env[INTERVIEW_AUTHORITY_DIGEST_SECRET_ENV]
  if (
    !encoded ||
    encoded.trim() !== encoded ||
    encoded.length > MAX_SECRET_BASE64_LENGTH ||
    !BASE64_PATTERN.test(encoded)
  ) {
    throw new InterviewAuthorityDigestError()
  }

  const secret = Buffer.from(encoded, 'base64')
  if (
    secret.length < 32 ||
    secret.toString('base64') !== encoded
  ) {
    secret.fill(0)
    throw new InterviewAuthorityDigestError()
  }
  return secret
}

/**
 * Computes a lowercase 64-hex HMAC while keeping the key server-only and
 * domain-separating every persisted PR8 authority/idempotency contract.
 */
export function digestInterviewAuthority(
  domain: InterviewAuthorityDigestDomain,
  value: unknown,
  dependencies: InterviewAuthorityDigestTestDependencies = {},
): string {
  if (!DOMAIN_SET.has(domain)) {
    throw new InterviewAuthorityDigestError()
  }
  const canonical = canonicalJson(value)
  const secret = configuredSecret(dependencies)
  const payload = Buffer.from(canonical, 'utf8')
  try {
    return createHmac('sha256', secret)
      .update(CONTRACT_PREFIX, 'utf8')
      .update('\0', 'utf8')
      .update(domain, 'utf8')
      .update('\0', 'utf8')
      .update(payload)
      .digest('hex')
  } catch {
    throw new InterviewAuthorityDigestError()
  } finally {
    secret.fill(0)
    payload.fill(0)
  }
}
