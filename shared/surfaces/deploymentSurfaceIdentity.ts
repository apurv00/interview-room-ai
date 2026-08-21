export type IpgDeploymentSurface = 'b2c' | 'hire-control' | 'hire-engine'

type DeploymentEnvironment = Record<string, string | undefined>

export interface DeploymentSurfaceIdentity {
  surface: IpgDeploymentSurface
  configurationIssue?: 'missing:IPG_SURFACE' | 'invalid:IPG_SURFACE'
}

/**
 * Resolve the deployment role without allowing a Hire manifest to silently
 * fall through to the legacy B2C default. Existing B2C deployments may keep
 * IPG_SURFACE blank only when no Hire database/worker identity is present.
 */
export function deploymentSurfaceIdentity(
  env: DeploymentEnvironment = process.env,
): DeploymentSurfaceIdentity {
  const configured = env.IPG_SURFACE
  if (
    configured === 'b2c' ||
    configured === 'hire-control' ||
    configured === 'hire-engine'
  ) {
    return { surface: configured }
  }
  if (configured !== undefined && configured !== '') {
    return { surface: 'b2c', configurationIssue: 'invalid:IPG_SURFACE' }
  }
  // Prefix-complete by design: adding a new Hire-only variable must fail
  // closed without requiring this identity boundary to be updated in lockstep.
  const hasHireManifest = Object.entries(env).some(
    ([name, value]) => name.startsWith('HIRE_') && Boolean(value?.trim()),
  )
  return hasHireManifest
    ? { surface: 'b2c', configurationIssue: 'missing:IPG_SURFACE' }
    : { surface: 'b2c' }
}
