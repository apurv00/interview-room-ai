import {
  deploymentSurfaceIdentity,
  type IpgDeploymentSurface,
} from './deploymentSurfaceIdentity'
import { hireIngestionRevisionProtocolState } from '../contracts/hireIngestionRevisionProtocol'

export type { IpgDeploymentSurface } from './deploymentSurfaceIdentity'

type DeploymentEnvironment = Record<string, string | undefined>

const FULL_GIT_SHA = /^[a-f0-9]{40}$/i

const DATABASE_SENTINELS = [
  'B2C_DATABASE_NAME',
  'HIRE_CONTROL_DATABASE_NAME',
  'HIRE_RUNTIME_DATABASE_NAME',
] as const

const INNGEST_SENTINELS = [
  'B2C_INNGEST_APP_ID',
  'HIRE_CONTROL_INNGEST_APP_ID',
  'HIRE_RUNTIME_INNGEST_APP_ID',
] as const

function configured(env: DeploymentEnvironment, name: string): boolean {
  return Boolean(env[name]?.trim())
}

function canonicalBase64Bytes(value: string | undefined, bytes: number): boolean {
  const encoded = value?.trim() ?? ''
  if (!encoded) return false
  const decoded = Buffer.from(encoded, 'base64')
  return decoded.length === bytes && decoded.toString('base64') === encoded
}

function requireVariables(
  env: DeploymentEnvironment,
  names: readonly string[],
  issues: Set<string>,
): void {
  for (const name of names) {
    if (!configured(env, name)) issues.add(`missing:${name}`)
  }
}

function requireDistinct(
  env: DeploymentEnvironment,
  names: readonly string[],
  issue: string,
  issues: Set<string>,
): void {
  const values = names.map((name) => env[name]?.trim()).filter(Boolean) as string[]
  if (values.length === names.length && new Set(values).size !== values.length) {
    issues.add(issue)
  }
}

function requireProductionHttpsUrl(
  env: DeploymentEnvironment,
  name: string,
  expectedHostname: string | undefined,
  issues: Set<string>,
): void {
  const configuredValue = env[name]
  const raw = configuredValue?.trim()
  if (!raw) return
  try {
    const parsed = new URL(raw)
    if (
      configuredValue !== raw ||
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (expectedHostname && parsed.hostname !== expectedHostname)
    ) {
      issues.add(`invalid:${name}`)
    }
  } catch {
    issues.add(`invalid:${name}`)
  }
}

function normalizedOrigin(value: string | undefined): string | null {
  const raw = value?.trim()
  if (!raw) return null
  try {
    return new URL(raw).origin
  } catch {
    return null
  }
}

export function currentDeploymentSurface(
  env: DeploymentEnvironment = process.env,
): IpgDeploymentSurface {
  return deploymentSurfaceIdentity(env).surface
}

/**
 * Static production invariants for the two isolated Hire deployments.
 *
 * These checks deliberately inspect only presence/equality/URL shape. They
 * never return secret values. Connectivity and the actual selected Mongo DB
 * are checked separately by the health route and the DB boundary.
 */
export function hireDeploymentConfigurationIssues(
  env: DeploymentEnvironment = process.env,
): string[] {
  const surfaceIdentity = deploymentSurfaceIdentity(env)
  if (surfaceIdentity.configurationIssue) {
    return [surfaceIdentity.configurationIssue]
  }
  const surface = surfaceIdentity.surface
  if (surface === 'b2c') return []

  const issues = new Set<string>()
  requireVariables(
    env,
    [
      'MONGODB_URI',
      'REDIS_URL',
      'HEALTH_CHECK_TOKEN',
      'DEPLOYMENT_COMMIT_SHA',
      'HIRE_ENGINE_BRIDGE_KEY_ID',
      'HIRE_ENGINE_BRIDGE_SECRET',
      ...DATABASE_SENTINELS,
      ...INNGEST_SENTINELS,
      'INNGEST_APP_ID',
      'INNGEST_SIGNING_KEY',
    ],
    issues,
  )
  requireDistinct(env, DATABASE_SENTINELS, 'collision:database-names', issues)
  requireDistinct(env, INNGEST_SENTINELS, 'collision:inngest-app-ids', issues)

  for (const name of DATABASE_SENTINELS) {
    if (configured(env, name) && env[name] !== env[name]?.trim()) {
      issues.add(`invalid:${name}`)
    }
  }

  if (!FULL_GIT_SHA.test(env.DEPLOYMENT_COMMIT_SHA?.trim() ?? '')) {
    issues.add('invalid:DEPLOYMENT_COMMIT_SHA')
  }

  if ((env.HIRE_ENGINE_BRIDGE_SECRET?.trim().length ?? 0) < 32) {
    issues.add('weak:HIRE_ENGINE_BRIDGE_SECRET')
  }
  const expectedInngestIdName =
    surface === 'hire-control'
      ? 'HIRE_CONTROL_INNGEST_APP_ID'
      : 'HIRE_RUNTIME_INNGEST_APP_ID'
  const expectedInngestId = env[expectedInngestIdName]?.trim()
  if (
    expectedInngestId &&
    (env[expectedInngestIdName] !== expectedInngestId ||
      env.INNGEST_APP_ID !== expectedInngestId)
  ) {
    issues.add('mismatch:INNGEST_APP_ID')
  }
  if (surface === 'hire-control') {
    requireVariables(
      env,
      [
        'NEXTAUTH_SECRET',
        'HIRE_HANDOFF_ISSUANCE_MODE',
        'HIRE_INGESTION_REVISION_PROTOCOL_MODE',
        'HIRE_PUBLIC_URL',
        'HIRE_ENGINE_RUNTIME_URL',
        'RESEND_API_KEY',
        'EMAIL_FROM',
        'HIRE_INVITE_DELIVERY_KEY_ID',
        'HIRE_INVITE_DELIVERY_KEY',
        'HIRE_ACCOUNT_BRIDGE_KEY_ID',
        'HIRE_ACCOUNT_BRIDGE_SECRET',
        'INNGEST_EVENT_KEY',
        'R2_ACCOUNT_ID',
        'R2_ACCESS_KEY_ID',
        'R2_SECRET_ACCESS_KEY',
        'R2_BUCKET_NAME',
        'HIRE_RUNTIME_R2_ACCOUNT_ID',
        'HIRE_RUNTIME_R2_ACCESS_KEY_ID',
        'HIRE_RUNTIME_R2_SECRET_ACCESS_KEY',
        'HIRE_RUNTIME_R2_BUCKET_NAME',
      ],
      issues,
    )
    if ((env.NEXTAUTH_SECRET?.trim().length ?? 0) < 32) {
      issues.add('weak:NEXTAUTH_SECRET')
    }
    if ((env.HIRE_ACCOUNT_BRIDGE_SECRET?.trim().length ?? 0) < 32) {
      issues.add('weak:HIRE_ACCOUNT_BRIDGE_SECRET')
    }
    if (
      configured(env, 'HIRE_ACCOUNT_BRIDGE_SECRET') &&
      env.HIRE_ACCOUNT_BRIDGE_SECRET === env.HIRE_ENGINE_BRIDGE_SECRET
    ) {
      issues.add('collision:bridge-secrets')
    }
    const handoffIssuanceMode = env.HIRE_HANDOFF_ISSUANCE_MODE?.trim()
    if (!['open', 'draining', 'smoke'].includes(handoffIssuanceMode ?? '')) {
      issues.add('invalid:HIRE_HANDOFF_ISSUANCE_MODE')
    }
    if (
      handoffIssuanceMode === 'smoke' &&
      Buffer.byteLength(env.HIRE_HANDOFF_SMOKE_TOKEN?.trim() ?? '', 'utf8') < 32
    ) {
      issues.add('weak:HIRE_HANDOFF_SMOKE_TOKEN')
    }
    const ingestionProtocol = hireIngestionRevisionProtocolState(env)
    if (
      !ingestionProtocol.explicitlyConfigured ||
      !['draining', 'required'].includes(ingestionProtocol.mode)
    ) {
      issues.add('invalid:HIRE_INGESTION_REVISION_PROTOCOL_MODE')
    }
    if (env.NODE_ENV === 'production' && ingestionProtocol.mode === 'draining') {
      if (!ingestionProtocol.drainMarkerValid) {
        issues.add('invalid:HIRE_INGESTION_REVISION_PROTOCOL_DRAIN_STARTED_AT')
      }
    }
    if (
      env.NODE_ENV === 'production' &&
      ingestionProtocol.mode === 'required' &&
      !ingestionProtocol.releaseReady
    ) {
      issues.add('not-ready:HIRE_INGESTION_REVISION_PROTOCOL')
    }
    if (!canonicalBase64Bytes(env.HIRE_INVITE_DELIVERY_KEY, 32)) {
      issues.add('invalid:HIRE_INVITE_DELIVERY_KEY')
    }
    const previousInviteKeyId = configured(env, 'HIRE_INVITE_DELIVERY_KEY_ID_PREVIOUS')
    const previousInviteKey = configured(env, 'HIRE_INVITE_DELIVERY_KEY_PREVIOUS')
    if (previousInviteKeyId !== previousInviteKey) {
      issues.add('incomplete:previous-invite-delivery-key')
    }
    if (
      previousInviteKey &&
      !canonicalBase64Bytes(env.HIRE_INVITE_DELIVERY_KEY_PREVIOUS, 32)
    ) {
      issues.add('invalid:HIRE_INVITE_DELIVERY_KEY_PREVIOUS')
    }
    if (
      previousInviteKeyId &&
      env.HIRE_INVITE_DELIVERY_KEY_ID_PREVIOUS?.trim() ===
        env.HIRE_INVITE_DELIVERY_KEY_ID?.trim()
    ) {
      issues.add('collision:invite-delivery-key-ids')
    }
    requireProductionHttpsUrl(env, 'HIRE_PUBLIC_URL', undefined, issues)
    requireProductionHttpsUrl(
      env,
      'HIRE_ENGINE_RUNTIME_URL',
      undefined,
      issues,
    )
    if (
      configured(env, 'HIRE_PUBLIC_URL') &&
      normalizedOrigin(env.HIRE_PUBLIC_URL) ===
        normalizedOrigin(env.HIRE_ENGINE_RUNTIME_URL)
    ) {
      issues.add('collision:hire-origins')
    }
  } else {
    requireVariables(
      env,
      [
        // next-auth/middleware reads the conventional secret before its
        // runtime-surface callback can default-allow the request. Keep this
        // middleware-only key distinct from the runtime session-signing key
        // below so a B2C cookie can never authenticate on the engine host.
        'NEXTAUTH_SECRET',
        'HIRE_RUNTIME_NEXTAUTH_SECRET',
        'HIRE_RUNTIME_FENCE_SECRET',
        'HIRE_CONTROL_URL',
        'HIRE_CONTROL_INTERNAL_URL',
        'HIRE_ENGINE_RUNTIME_URL',
        'NEXTAUTH_URL',
        'R2_ACCOUNT_ID',
        'R2_ACCESS_KEY_ID',
        'R2_SECRET_ACCESS_KEY',
        'R2_BUCKET_NAME',
        'HIRE_RUNTIME_R2_ACCOUNT_ID',
        'HIRE_RUNTIME_R2_ACCESS_KEY_ID',
        'HIRE_RUNTIME_R2_SECRET_ACCESS_KEY',
        'HIRE_RUNTIME_R2_BUCKET_NAME',
        'NEXT_PUBLIC_FEATURE_MULTIMODAL',
      ],
      issues,
    )
    if ((env.NEXTAUTH_SECRET?.trim().length ?? 0) < 32) {
      issues.add('weak:NEXTAUTH_SECRET')
    }
    if ((env.HIRE_RUNTIME_NEXTAUTH_SECRET?.trim().length ?? 0) < 32) {
      issues.add('weak:HIRE_RUNTIME_NEXTAUTH_SECRET')
    }
    if ((env.HIRE_RUNTIME_FENCE_SECRET?.trim().length ?? 0) < 32) {
      issues.add('weak:HIRE_RUNTIME_FENCE_SECRET')
    }
    if (env.NEXT_PUBLIC_FEATURE_MULTIMODAL !== 'true') {
      issues.add('invalid:NEXT_PUBLIC_FEATURE_MULTIMODAL')
    }
    if (
      configured(env, 'NEXTAUTH_SECRET') &&
      env.NEXTAUTH_SECRET?.trim() === env.HIRE_RUNTIME_NEXTAUTH_SECRET?.trim()
    ) {
      issues.add('collision:nextauth-secrets')
    }
    for (const [engineName, runtimeName] of [
      ['R2_ACCOUNT_ID', 'HIRE_RUNTIME_R2_ACCOUNT_ID'],
      ['R2_ACCESS_KEY_ID', 'HIRE_RUNTIME_R2_ACCESS_KEY_ID'],
      ['R2_SECRET_ACCESS_KEY', 'HIRE_RUNTIME_R2_SECRET_ACCESS_KEY'],
      ['R2_BUCKET_NAME', 'HIRE_RUNTIME_R2_BUCKET_NAME'],
    ] as const) {
      if (
        configured(env, engineName) &&
        configured(env, runtimeName) &&
        (env[engineName] !== env[engineName]?.trim() ||
          env[runtimeName] !== env[runtimeName]?.trim() ||
          env[engineName] !== env[runtimeName])
      ) {
        issues.add(`mismatch:${engineName}`)
      }
    }
    requireProductionHttpsUrl(env, 'HIRE_CONTROL_URL', undefined, issues)
    requireProductionHttpsUrl(env, 'HIRE_CONTROL_INTERNAL_URL', undefined, issues)
    requireProductionHttpsUrl(
      env,
      'HIRE_ENGINE_RUNTIME_URL',
      undefined,
      issues,
    )
    requireProductionHttpsUrl(env, 'NEXTAUTH_URL', undefined, issues)
    if (
      configured(env, 'NEXTAUTH_URL') &&
      env.NEXTAUTH_URL !== env.HIRE_ENGINE_RUNTIME_URL
    ) {
      issues.add('mismatch:NEXTAUTH_URL')
    }
    if (
      configured(env, 'HIRE_CONTROL_INTERNAL_URL') &&
      normalizedOrigin(env.HIRE_CONTROL_INTERNAL_URL) ===
        normalizedOrigin(env.HIRE_ENGINE_RUNTIME_URL)
    ) {
      issues.add('collision:hire-origins')
    }
    if (
      configured(env, 'HIRE_CONTROL_URL') &&
      normalizedOrigin(env.HIRE_CONTROL_URL) ===
        normalizedOrigin(env.HIRE_ENGINE_RUNTIME_URL)
    ) {
      issues.add('collision:hire-origins')
    }
    // The unchanged feedback route emits B2C-only enrichment events. Runtime
    // jobs are cron-driven, so withholding its outbound event key prevents
    // those pseudonymous IDs from entering a shared B2C Inngest environment
    // while still allowing signed function delivery.
    if (configured(env, 'INNGEST_EVENT_KEY')) {
      issues.add('unsafe:runtime-event-egress')
    }
  }

  return Array.from(issues).sort()
}
