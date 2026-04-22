/**
 * Shared connection constants for the two Mongo clients in this codebase:
 *   - `shared/db/connection.ts` — Mongoose client used by all app-data routes
 *   - `shared/db/mongoClient.ts` — raw MongoDB driver used by NextAuth's
 *     `@next-auth/mongodb-adapter`
 *
 * Both talk to the same Atlas cluster; their driver options MUST agree on
 * timeouts, or the one with the shorter timeout will fail in isolation
 * during Atlas cold-connect windows while the other survives.
 *
 * ─────────────────────────────────────────────────────────────────
 * 2026-04-22 P0 fix — context for the shared constant
 * ─────────────────────────────────────────────────────────────────
 *
 * Before this file existed the two clients had diverged:
 *
 *   connection.ts:99   → `serverSelectionTimeoutMS: 15000`  (Mongoose)
 *   mongoClient.ts:5   → `serverSelectionTimeoutMS:  5000`  (NextAuth)
 *
 * Atlas M0 (shared free tier) can take 10–15 s to wake from idle on
 * cold serverless invocations. With the split:
 *   - Mongoose paths (e.g. /api/generate-question, /api/evaluate-answer)
 *     survived the wake-up and succeeded.
 *   - NextAuth's /api/auth/session failed at the 5 s boundary with
 *     `MongoServerSelectionError: Server selection timed out after
 *     5000 ms` — see the 2026-04-22 session 69e8f4eb diagnostic logs
 *     where this error fired 4× in 30 minutes on auth calls while the
 *     same-cluster app data calls on the same session were fine.
 *
 * The NextAuth failures returned HTTP 200 from the route (NextAuth
 * catches adapter errors and degrades to no-session), so the user saw
 * no surface-level error but any feature gated on `getServerSession`
 * degraded silently. Centralising the timeout here means a future edit
 * that bumps or lowers the value applies uniformly — the two clients
 * can never drift again.
 */

/**
 * How long the MongoDB driver waits for the Atlas topology to
 * elect/expose a servable node before giving up with
 * `MongoServerSelectionError`. 15 s accommodates M0 cold-wake latency
 * with enough headroom to stay inside Vercel's default serverless
 * request budget for `/api/auth/session`.
 */
export const MONGO_SERVER_SELECTION_TIMEOUT_MS = 15_000

/**
 * How long an individual socket is allowed to be idle before the
 * driver tears it down. Matches `connection.ts`'s existing setting
 * (unchanged — surfaced here only for future-proofing if we ever
 * wire the raw-driver `mongoClient.ts` to use it too).
 */
export const MONGO_SOCKET_TIMEOUT_MS = 45_000

/**
 * Connection pool cap. Both clients use the same value today; surfaced
 * for consistency with the other timeouts.
 */
export const MONGO_MAX_POOL_SIZE = 10
