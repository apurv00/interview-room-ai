const FULL_GIT_SHA = /^[a-f0-9]{40}$/i

interface DeploymentEnvironment {
  DEPLOYMENT_COMMIT_SHA?: string
  SOURCE_COMMIT?: string
  VERCEL_GIT_COMMIT_SHA?: string
}

/** Exact revision identity used by deployment-sensitive release gates. */
export function deploymentCommitOf(
  environment: DeploymentEnvironment = process.env as DeploymentEnvironment,
): string | null {
  for (const candidate of [
    environment.DEPLOYMENT_COMMIT_SHA,
    environment.SOURCE_COMMIT,
    environment.VERCEL_GIT_COMMIT_SHA,
  ]) {
    const normalized = candidate?.trim().toLowerCase()
    if (normalized && FULL_GIT_SHA.test(normalized)) return normalized
  }
  return null
}
