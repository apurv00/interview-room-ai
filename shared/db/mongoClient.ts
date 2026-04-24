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
    globalWithMongo._mongoClientPromise = client.connect()
  }
  return globalWithMongo._mongoClientPromise
}

const clientPromise = getClientPromise()

export default clientPromise
