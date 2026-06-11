import { MongoClient } from 'mongodb'
import {
  MONGO_CONNECT_TIMEOUT_MS,
  MONGO_MAX_POOL_SIZE,
  MONGO_SERVER_SELECTION_TIMEOUT_MS,
  MONGO_SOCKET_TIMEOUT_MS,
} from './mongoConfig'

// Timeouts + pool size come from the shared constants module so this
// NextAuth-adapter client cannot drift from Mongoose's `connection.ts`.
// See shared/db/mongoConfig.ts for the full incident context:
//   - 2026-04-22: `serverSelectionTimeoutMS` was 5 s here vs 15 s in
//     Mongoose; silently killed /api/auth/session on Atlas slow.
//   - 2026-04-23: `connectTimeoutMS` defaulted to the driver's 30 s
//     and produced a 40.7 s secureConnect hang on a cold Lambda.
//     `socketTimeoutMS` was also missing here while set in Mongoose.
//   Both gaps are closed below.
const options = {
  maxPoolSize: MONGO_MAX_POOL_SIZE,
  serverSelectionTimeoutMS: MONGO_SERVER_SELECTION_TIMEOUT_MS,
  socketTimeoutMS: MONGO_SOCKET_TIMEOUT_MS,
  connectTimeoutMS: MONGO_CONNECT_TIMEOUT_MS,
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
    const pending = client.connect()
    // Guard the cached promise the same way connection.ts (Mongoose) does:
    //   1. A no-op `.catch` so a connection rejection — e.g. a
    //      MongoServerSelectionError / `secureConnect` timeout, common when this
    //      cached promise spans a Vercel Lambda freeze/thaw and the socket dies —
    //      is never an UNHANDLED rejection. Node >=15 crashes the process on an
    //      unhandled rejection, which in a shared serverless host kills co-located
    //      work. The real rejection still reaches awaiters (NextAuth adapter) via
    //      their own await.
    //   2. Clear the cache on failure so the next call retries a FRESH connection
    //      instead of returning the same rejected promise forever — otherwise a
    //      single cold-start/freeze failure bricks auth until the Lambda recycles.
    pending.catch(() => {
      if (globalWithMongo._mongoClientPromise === pending) {
        globalWithMongo._mongoClientPromise = undefined
      }
    })
    globalWithMongo._mongoClientPromise = pending
  }
  return globalWithMongo._mongoClientPromise
}

const clientPromise = getClientPromise()

export default clientPromise
