import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'

export function assertHireRuntimeSurface(): void {
  if (process.env.IPG_SURFACE !== 'hire-engine') {
    throw new Error('Hire runtime service invoked outside the isolated runtime deployment')
  }
}

/**
 * The unchanged interview engine uses the default Mongoose connection.  This
 * guard therefore runs before every runtime operation and proves that the
 * default connection is the dedicated runtime database, never the B2C DB.
 */
export async function connectHireRuntimeDB(): Promise<void> {
  assertHireRuntimeSurface()
  const expectedDatabase = process.env.HIRE_RUNTIME_DATABASE_NAME
  const b2cDatabase = process.env.B2C_DATABASE_NAME
  const controlDatabase = process.env.HIRE_CONTROL_DATABASE_NAME
  if (
    !expectedDatabase ||
    (process.env.NODE_ENV === 'production' && (!b2cDatabase || !controlDatabase))
  ) {
    throw new Error('Hire runtime database boundary is not configured')
  }
  await connectDB()
  if (mongoose.connection.name !== expectedDatabase) {
    throw new Error(
      `Hire runtime database mismatch: expected ${expectedDatabase}, got ${mongoose.connection.name}`,
    )
  }
  if (
    (b2cDatabase && expectedDatabase === b2cDatabase) ||
    (controlDatabase && expectedDatabase === controlDatabase)
  ) {
    throw new Error('Hire runtime, Hire control, and B2C databases must be distinct')
  }
}
