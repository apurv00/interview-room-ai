import { MongoClient } from 'mongodb'
import { MONGO_MAX_POOL_SIZE, MONGO_SERVER_SELECTION_TIMEOUT_MS } from './mongoConfig'

// Timeouts + pool size come from the shared constants module so this
// NextAuth-adapter client cannot drift from Mongoose's `connection.ts`.
// Pre-2026-04-22 this file hardcoded a 5 s selection timeout which
// produced the `MongoServerSelectionError: Server selection timed out`
// failures on /api/auth/session when Atlas was slow. See
// shared/db/mongoConfig.ts for the full incident context.
const options = {
  maxPoolSize: MONGO_MAX_POOL_SIZE,
  serverSelectionTimeoutMS: MONGO_SERVER_SELECTION_TIMEOUT_MS,
}

const globalWithMongo = global as typeof globalThis & {
  _mongoClientPromise?: Promise<MongoClient>
}

function getClientPromise(): Promise<MongoClient> {
  const MONGODB_URI = process.env.MONGODB_URI
  if (!MONGODB_URI) {
    // Return a promise that rejects lazily so it doesn't crash at build time
    return Promise.reject(new Error('MONGODB_URI environment variable is not defined'))
  }

  // Cache the client promise in both dev and production to avoid
  // creating a new TCP connection on every serverless invocation.
  if (!globalWithMongo._mongoClientPromise) {
    const client = new MongoClient(MONGODB_URI, options)
    globalWithMongo._mongoClientPromise = client.connect()
  }
  return globalWithMongo._mongoClientPromise
}

const clientPromise = getClientPromise()

export default clientPromise
