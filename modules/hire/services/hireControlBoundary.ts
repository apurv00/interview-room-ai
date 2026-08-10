import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'

/** Fail-closed connection guard for the Hire control-plane deployment. */
export async function connectHireControlDB(): Promise<void> {
  const surface = process.env.IPG_SURFACE
  const expectedDatabase = process.env.HIRE_CONTROL_DATABASE_NAME
  const b2cDatabase = process.env.B2C_DATABASE_NAME
  const runtimeDatabase = process.env.HIRE_RUNTIME_DATABASE_NAME
  if (
    surface !== 'hire-control' ||
    !expectedDatabase ||
    (process.env.NODE_ENV === 'production' && (!b2cDatabase || !runtimeDatabase))
  ) {
    throw new Error('Hire control database boundary is not configured')
  }
  await connectDB()
  if (mongoose.connection.name !== expectedDatabase) {
    throw new Error(
      `Hire control database mismatch: expected ${expectedDatabase}, got ${mongoose.connection.name}`,
    )
  }
  if (
    (b2cDatabase && expectedDatabase === b2cDatabase) ||
    (runtimeDatabase && expectedDatabase === runtimeDatabase)
  ) {
    throw new Error('Hire control, Hire runtime, and B2C databases must be distinct')
  }
}
