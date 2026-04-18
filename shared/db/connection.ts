import mongoose from 'mongoose'

interface CachedConnection {
  conn: typeof mongoose | null
  promise: Promise<typeof mongoose> | null
}

const globalWithMongoose = global as typeof globalThis & {
  mongoose: CachedConnection
}

if (!globalWithMongoose.mongoose) {
  globalWithMongoose.mongoose = { conn: null, promise: null }
}

const cached = globalWithMongoose.mongoose

/** Mongoose's readyState values:
 *  0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting */
function isConnected(): boolean {
  return mongoose.connection.readyState === 1
}

export async function connectDB(): Promise<typeof mongoose> {
  const MONGODB_URI = process.env.MONGODB_URI
  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI environment variable is not defined')
  }

  // Validate that a cached connection is actually still live. Previously
  // we trusted `cached.conn` indefinitely, which meant a dropped socket
  // would silently return a stale handle and the next query would fail
  // with an unhandled "(node:4) [MONGOOSE]" warning. Now we verify
  // readyState on every call and re-connect on mismatch.
  if (cached.conn && isConnected()) return cached.conn
  if (cached.conn && !isConnected()) {
    cached.conn = null
    cached.promise = null
  }

  if (!cached.promise) {
    const pending = mongoose.connect(MONGODB_URI, {
      bufferCommands: false,
      maxPoolSize: 10,
      // Bumped from 5000 to 15000 because Atlas M0 (shared free tier) can
      // take 10-15s to wake up from idle on cold serverless invocations.
      // The old 5s caused `MongoServerSelectionError` outright; 15s lets
      // the M0 cluster respond before the driver gives up.
      serverSelectionTimeoutMS: 15000,
      socketTimeoutMS: 45000,
    })
    // Attach a no-op `.catch` so that if the caller is delayed or a
    // parallel invocation doesn't await this promise, Node never logs an
    // UnhandledPromiseRejection. The real rejection is still surfaced
    // below via the awaited try/catch.
    pending.catch(() => { /* handled below */ })
    cached.promise = pending
  }

  try {
    cached.conn = await cached.promise
  } catch (e) {
    cached.promise = null
    cached.conn = null
    throw e
  }

  return cached.conn
}

