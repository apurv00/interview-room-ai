import mongoose from 'mongoose'
import { isFeatureEnabled } from '@shared/featureFlags'
import { aiLogger } from '@shared/logger'
import {
  MONGO_CONNECT_TIMEOUT_MS,
  MONGO_MAX_POOL_SIZE,
  MONGO_SERVER_SELECTION_TIMEOUT_MS,
  MONGO_SOCKET_TIMEOUT_MS,
} from './mongoConfig'

interface CachedConnection {
  conn: typeof mongoose | null
  promise: Promise<typeof mongoose> | null
  schemaInitialization: 'default' | 'disabled' | null
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
  globalWithMongoose.mongoose = { conn: null, promise: null, schemaInitialization: null }
}

const cached = globalWithMongoose.mongoose

/** Mongoose's readyState values:
 *  0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting */
function isConnected(): boolean {
  return mongoose.connection.readyState === 1
}

export interface ConnectDBOptions {
  /** Disable Mongoose collection/index initialization for repair dry-runs and
   *  read-only promotion checks. Explicit writes still work in --apply mode. */
  schemaInitialization?: 'default' | 'disabled'
}

/**
 * The Hire control plane and the unchanged interview-engine runtime are
 * deliberately deployed with different Mongo principals and databases.
 * Validate the URI before Mongoose connects: checking connection.name after
 * connect is too late because model initialization may already create indexes
 * in the wrong database.
 *
 * Ordinary B2C processes do not set IPG_SURFACE, so their connection behavior
 * remains byte-for-byte equivalent to the pre-Hire path.
 */
function assertHireSurfaceDatabaseBoundary(mongodbUri: string): void {
  const surface = process.env.IPG_SURFACE
  if (surface !== 'hire-control' && surface !== 'hire-engine') return

  const controlDatabase = process.env.HIRE_CONTROL_DATABASE_NAME?.trim()
  const runtimeDatabase = process.env.HIRE_RUNTIME_DATABASE_NAME?.trim()
  const b2cDatabase = process.env.B2C_DATABASE_NAME?.trim()
  if (!controlDatabase || !runtimeDatabase || !b2cDatabase) {
    throw new Error('Hire database boundary is not configured')
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
  const expectedDatabase = surface === 'hire-control' ? controlDatabase : runtimeDatabase
  if (!actualDatabase || actualDatabase !== expectedDatabase) {
    throw new Error(
      `Hire ${surface === 'hire-control' ? 'control' : 'runtime'} database URI mismatch`,
    )
  }
}

export async function connectDB(options: ConnectDBOptions = {}): Promise<typeof mongoose> {
  const MONGODB_URI = process.env.MONGODB_URI
  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI environment variable is not defined')
  }
  assertHireSurfaceDatabaseBoundary(MONGODB_URI)

  // Validate that a cached connection is actually still live. Previously
  // we trusted `cached.conn` indefinitely, which meant a dropped socket
  // would silently return a stale handle and the next query would fail
  // with an unhandled "(node:4) [MONGOOSE]" warning. Now we verify
  // readyState on every call and re-connect on mismatch.
  if (cached.conn && !isConnected()) {
    cached.conn = null
    cached.promise = null
    cached.schemaInitialization = null
  }

  const requestedSchemaInitialization = options.schemaInitialization ?? 'default'
  if (cached.conn || cached.promise) {
    const activeSchemaInitialization = cached.schemaInitialization ?? 'default'
    if (activeSchemaInitialization !== requestedSchemaInitialization) {
      throw new Error(
        `Mongo connection already initialized in ${activeSchemaInitialization} schema mode; refusing ${requestedSchemaInitialization}`,
      )
    }
  }
  if (cached.conn && isConnected()) return cached.conn

  if (!cached.promise) {
    // Timeouts + pool size come from the shared constants module so this
    // Mongoose client stays in lock-step with the raw-driver
    // `mongoClient.ts` used by NextAuth. Pre-2026-04-22 the two were
    // hardcoded separately and had drifted; see shared/db/mongoConfig.ts
    // for the incident context.
    cached.schemaInitialization = requestedSchemaInitialization
    const pending = mongoose.connect(MONGODB_URI, {
      bufferCommands: false,
      // Legal/source-authority gates must never inherit a stale-secondary
      // preference from a deployment URI. This preserves Mongo's normal
      // default while making the safety boundary explicit for every caller.
      readPreference: 'primary',
      maxPoolSize: MONGO_MAX_POOL_SIZE,
      serverSelectionTimeoutMS: MONGO_SERVER_SELECTION_TIMEOUT_MS,
      socketTimeoutMS: MONGO_SOCKET_TIMEOUT_MS,
      connectTimeoutMS: MONGO_CONNECT_TIMEOUT_MS,
      ...(requestedSchemaInitialization === 'disabled'
        ? { autoIndex: false, autoCreate: false }
        : {}),
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
    cached.schemaInitialization = null
    throw e
  }

  return cached.conn
}
