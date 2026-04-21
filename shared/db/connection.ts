import mongoose from 'mongoose'
import { isFeatureEnabled } from '@shared/featureFlags'
import { aiLogger } from '@shared/logger'

interface CachedConnection {
  conn: typeof mongoose | null
  promise: Promise<typeof mongoose> | null
}

/**
 * Conditional connectDB wrapper for hot-path routes (PR C Phase 1).
 *
 * Callers pass `needsMongo = true` when the code path AFTER this call
 * is going to hit Mongo, or `false` when all required data was already
 * served from caches (session config, ModelConfig L1/L2). When the
 * `skip_connectdb_when_cached` feature flag is ON and needsMongo is
 * false, skips the TLS+SCRAM handshake entirely and emits
 * `event:connectdb_bypass` for observability.
 *
 * Defaults to the old behavior (always connect) when flag is OFF, so
 * the rollout is zero-risk until the flag is flipped in Vercel env.
 *
 * @param needsMongo Does the code immediately after this call fire a Mongo query?
 * @param context Short identifier (route name) surfaced in the bypass log.
 * @param needReason Optional field-level reason for needsMongo=true. When the
 *   flag is ON but we still had to connect, this is logged as
 *   `event:connectdb_needed` so operators can identify which cached field was
 *   null (e.g. `userProfile-null`, `domain-null`). Silent on flag-off runs —
 *   the flag-off case is "rollout not started", not a data problem.
 */
export async function connectDBIfNeeded(
  needsMongo: boolean,
  context: string,
  needReason?: string,
): Promise<void> {
  const flagOn = isFeatureEnabled('skip_connectdb_when_cached')
  if (needsMongo || !flagOn) {
    if (flagOn && needsMongo) {
      // Flag is ON and we STILL had to connect — exposes which cached
      // field was null so we can debug why PR C bypass isn't firing
      // in production. Added 2026-04-21 after the flag was flipped on
      // and no `event:connectdb_bypass` appeared in logs — we couldn't
      // tell whether the cache was under-populated or over-reporting.
      aiLogger.info(
        { event: 'connectdb_needed', context, reason: needReason ?? 'unspecified' },
        'connectDB called despite skip flag — cache did not cover all required fields',
      )
    }
    await connectDB()
    return
  }
  aiLogger.info(
    { event: 'connectdb_bypass', context },
    'connectDB skipped — cache populated all required fields',
  )
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

