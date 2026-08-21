import { timingSafeEqual } from 'node:crypto'

export type HireHandoffIssuanceMode = 'open' | 'draining' | 'smoke'

type DeploymentEnvironment = Record<string, string | undefined>

const VALID_MODES = new Set<HireHandoffIssuanceMode>([
  'open',
  'draining',
  'smoke',
])
const MIN_SMOKE_TOKEN_BYTES = 32

export interface HireHandoffIssuanceState {
  mode: HireHandoffIssuanceMode
  explicitlyConfigured: boolean
  publicIssuanceOpen: boolean
  smokeReady: boolean
}

function smokeToken(env: DeploymentEnvironment): string {
  return env.HIRE_HANDOFF_SMOKE_TOKEN?.trim() ?? ''
}

export function hireHandoffIssuanceState(
  env: DeploymentEnvironment = process.env,
): HireHandoffIssuanceState {
  const configuredMode = env.HIRE_HANDOFF_ISSUANCE_MODE?.trim()
  const explicitlyConfigured = VALID_MODES.has(
    configuredMode as HireHandoffIssuanceMode,
  )
  // Production fails closed when the switch is absent or malformed. Local
  // development/test remains open so this operational gate cannot silently
  // change non-production candidate fixtures.
  const mode: HireHandoffIssuanceMode = explicitlyConfigured
    ? configuredMode as HireHandoffIssuanceMode
    : env.NODE_ENV === 'production'
      ? 'draining'
      : 'open'
  return {
    mode,
    explicitlyConfigured,
    publicIssuanceOpen: mode === 'open',
    smokeReady: Buffer.byteLength(smokeToken(env), 'utf8') >= MIN_SMOKE_TOKEN_BYTES,
  }
}

export function hireHandoffIssuanceAllowed(
  headers: Pick<Headers, 'get'>,
  env: DeploymentEnvironment = process.env,
): boolean {
  const state = hireHandoffIssuanceState(env)
  if (state.mode === 'open') return true
  if (state.mode !== 'smoke' || !state.smokeReady) return false

  const expected = Buffer.from(smokeToken(env), 'utf8')
  const provided = Buffer.from(
    headers.get('x-hire-handoff-smoke-token')?.trim() ?? '',
    'utf8',
  )
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}

export const __hireHandoffIssuanceGate = {
  MIN_SMOKE_TOKEN_BYTES,
  VALID_MODES,
}
