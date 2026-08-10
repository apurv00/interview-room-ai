export type IpgDeploymentSurface = 'b2c' | 'hire-control' | 'hire-engine'

type DeploymentEnvironment = Record<string, string | undefined>

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
  const raw = env[name]?.trim()
  if (!raw) return
  try {
    const parsed = new URL(raw)
    if (
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

export function currentDeploymentSurface(
  env: DeploymentEnvironment = process.env,
): IpgDeploymentSurface {
  if (env.IPG_SURFACE === 'hire-control') return 'hire-control'
  if (env.IPG_SURFACE === 'hire-engine') return 'hire-engine'
  return 'b2c'
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
  const surface = currentDeploymentSurface(env)
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

  if ((env.HIRE_ENGINE_BRIDGE_SECRET?.trim().length ?? 0) < 32) {
    issues.add('weak:HIRE_ENGINE_BRIDGE_SECRET')
  }

  const expectedInngestId =
    surface === 'hire-control'
      ? env.HIRE_CONTROL_INNGEST_APP_ID?.trim()
      : env.HIRE_RUNTIME_INNGEST_APP_ID?.trim()
  if (expectedInngestId && env.INNGEST_APP_ID?.trim() !== expectedInngestId) {
    issues.add('mismatch:INNGEST_APP_ID')
  }
  if (surface === 'hire-control') {
    requireVariables(
      env,
      [
        'NEXTAUTH_SECRET',
        'HIRE_PUBLIC_URL',
        'HIRE_ENGINE_RUNTIME_URL',
        'RESEND_API_KEY',
        'EMAIL_FROM',
        'HIRE_INVITE_DELIVERY_KEY_ID',
        'HIRE_INVITE_DELIVERY_KEY',
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
      env.HIRE_PUBLIC_URL?.trim() === env.HIRE_ENGINE_RUNTIME_URL?.trim()
    ) {
      issues.add('collision:hire-origins')
    }
  } else {
    requireVariables(
      env,
      [
        'HIRE_RUNTIME_NEXTAUTH_SECRET',
        'HIRE_RUNTIME_FENCE_SECRET',
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
      ],
      issues,
    )
    if ((env.HIRE_RUNTIME_NEXTAUTH_SECRET?.trim().length ?? 0) < 32) {
      issues.add('weak:HIRE_RUNTIME_NEXTAUTH_SECRET')
    }
    if ((env.HIRE_RUNTIME_FENCE_SECRET?.trim().length ?? 0) < 32) {
      issues.add('weak:HIRE_RUNTIME_FENCE_SECRET')
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
        env[engineName]?.trim() !== env[runtimeName]?.trim()
      ) {
        issues.add(`mismatch:${engineName}`)
      }
    }
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
      env.NEXTAUTH_URL?.trim() !== env.HIRE_ENGINE_RUNTIME_URL?.trim()
    ) {
      issues.add('mismatch:NEXTAUTH_URL')
    }
    if (
      configured(env, 'HIRE_CONTROL_INTERNAL_URL') &&
      env.HIRE_CONTROL_INTERNAL_URL?.trim() ===
        env.HIRE_ENGINE_RUNTIME_URL?.trim()
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
