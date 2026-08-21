import { deploymentSurfaceIdentity } from '@shared/surfaces/deploymentSurfaceIdentity'

/**
 * Fail closed before either Mongo driver can touch a database outside the
 * deployment's declared Hire surface.
 */
export function assertHireSurfaceDatabaseBoundary(mongodbUri: string): void {
  const surfaceIdentity = deploymentSurfaceIdentity()
  if (surfaceIdentity.configurationIssue) {
    throw new Error(`Deployment surface identity is invalid: ${surfaceIdentity.configurationIssue}`)
  }
  const surface = surfaceIdentity.surface
  if (surface === 'b2c') return

  const controlDatabase = process.env.HIRE_CONTROL_DATABASE_NAME
  const runtimeDatabase = process.env.HIRE_RUNTIME_DATABASE_NAME
  const b2cDatabase = process.env.B2C_DATABASE_NAME
  if (!controlDatabase || !runtimeDatabase || !b2cDatabase) {
    throw new Error('Hire database boundary is not configured')
  }
  if (
    [controlDatabase, runtimeDatabase, b2cDatabase].some(
      (database) => database !== database.trim(),
    )
  ) {
    throw new Error('Hire database identity must not contain surrounding whitespace')
  }
  if (new Set([controlDatabase, runtimeDatabase, b2cDatabase]).size !== 3) {
    throw new Error('Hire control, Hire runtime, and B2C databases must be distinct')
  }

  // WHATWG URL rejects valid replica-set authorities containing commas, so
  // parse only the database-path portion shared by mongodb and mongodb+srv.
  const match = mongodbUri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^/?#]+)(?:[?#]|$)/i)
  let actualDatabase: string
  try {
    actualDatabase = match ? decodeURIComponent(match[1]) : ''
  } catch {
    actualDatabase = ''
  }
  const expectedDatabase =
    surface === 'hire-control' ? controlDatabase : runtimeDatabase
  if (!actualDatabase || actualDatabase !== expectedDatabase) {
    throw new Error(
      `Hire ${surface === 'hire-control' ? 'control' : 'runtime'} database URI mismatch`,
    )
  }
}
