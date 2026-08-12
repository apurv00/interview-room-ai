export type DeploymentSurface = 'b2c' | 'hire-control' | 'hire-runtime'

const ALWAYS_ISOLATED_PATH_PREFIXES = [
  '/workspace',
  '/candidate',
  '/apply',
  '/handoff',
  '/hire-signin',
] as const

function normalizeHostname(rawHostname: string | null | undefined): string {
  const trimmed = rawHostname?.trim().toLowerCase() ?? ''
  if (!trimmed) return ''

  const withoutPort = trimmed.startsWith('[')
    ? trimmed.slice(0, trimmed.indexOf(']') + 1)
    : trimmed.split(':', 1)[0]
  return withoutPort.replace(/\.$/, '')
}

function hostnameFromUrl(rawUrl: string | null | undefined): string {
  if (!rawUrl) return ''
  try {
    return normalizeHostname(new URL(rawUrl).hostname)
  } catch {
    return ''
  }
}

function isPathAtOrBelow(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

export function resolveDeploymentSurface(input: {
  configuredSurface?: string | null
  hostname?: string | null
  runtimeUrl?: string | null
}): DeploymentSurface {
  if (input.configuredSurface === 'hire-engine' || input.configuredSurface === 'hire-runtime') {
    return 'hire-runtime'
  }
  if (input.configuredSurface === 'hire-control') return 'hire-control'

  const hostname = normalizeHostname(input.hostname)
  if (!hostname) return 'b2c'

  const runtimeHostname = hostnameFromUrl(input.runtimeUrl)
  if (runtimeHostname && hostname === runtimeHostname) return 'hire-runtime'

  const firstLabel = hostname.split('.')[0]
  if (firstLabel === 'hire') return 'hire-control'
  if (firstLabel === 'hire-runtime' || firstLabel === 'hire-engine') {
    return 'hire-runtime'
  }

  return 'b2c'
}

/**
 * Hire control routes are isolated even when exercised on the main host in
 * local/test deployments. Lobby and interview are intentionally *not* path
 * denied: they are also real B2C surfaces and become isolated only when the
 * deployment itself is the dedicated Hire runtime.
 */
export function isHireIsolatedSurface(input: {
  deploymentSurface: DeploymentSurface
  pathname: string
}): boolean {
  if (input.deploymentSurface !== 'b2c') return true
  return ALWAYS_ISOLATED_PATH_PREFIXES.some((prefix) => isPathAtOrBelow(input.pathname, prefix))
}

/**
 * Public Hire capability pages never need a NextAuth session. Keeping the
 * provider off these paths prevents a matching candidate's browser from even
 * hydrating a domain-wide B2C account. The legacy B2C thank-you page remains
 * session-backed until that separate flow is retired.
 */
export function isHirePublicSessionlessPath(pathname: string): boolean {
  if (isPathAtOrBelow(pathname, '/apply')) return true
  return (
    isPathAtOrBelow(pathname, '/candidate') &&
    !isPathAtOrBelow(pathname, '/candidate/thank-you')
  )
}
