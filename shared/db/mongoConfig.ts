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
 * 2026-04-23 observation — Lambda cold-start vs Atlas cold-wake
 * ─────────────────────────────────────────────────────────────────
 *
 * Session 69e9a51b5a8426e4f81b1203 (2026-04-23) produced three
 * `/api/auth/*` failures pre-session:
 *   - 2× `MongoServerSelectionError` at exactly 15000ms
 *   - 1× `MongoNetworkTimeoutError: Socket 'secureConnect' timed out
 *     after 40698ms (connectTimeoutMS: 30000)`
 *
 * The `keepMongoWarmJob` (`modules/learn/jobs/keepMongoWarm.ts`) was
 * running — Atlas was warm. These failures were Vercel Lambda
 * cold-starts, not Atlas cold-wakes:
 *
 *   New Vercel Lambda spins up → fresh Node process → empty
 *   `_mongoClientPromise` global → first request triggers
 *   `client.connect()` → TCP + TLS handshake to a specific replica
 *   node. If that node is briefly slow, the driver's default
 *   `connectTimeoutMS: 30000` let the handshake hang + retry up to
 *   ~40 s before bubbling up.
 *
 * Keeping Atlas warm is necessary but not sufficient — the per-
 * connect timeout also has to be bounded. Hence `MONGO_CONNECT_TIMEOUT_MS`
 * below, wired into both clients.
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
 * driver tears it down. Matches `connection.ts`'s existing setting.
 * Wired into `mongoClient.ts` from 2026-04-23 onward (previously
 * missing there — the raw driver used its implicit default).
 */
export const MONGO_SOCKET_TIMEOUT_MS = 45_000

/**
 * How long the driver waits for a single TCP + TLS handshake to a
 * specific replica node before tearing down the attempt.
 *
 * Why 10 s:
 *   - MUST be < `MONGO_SERVER_SELECTION_TIMEOUT_MS` (15 s). Otherwise
 *     server selection times out first and this value never has
 *     effect. 10 s gives the outer loop at least one retry on a
 *     sibling replica within its 15 s budget.
 *   - MUST be > warm-Atlas TLS handshake latency (100-500 ms with
 *     10-20× headroom for jitter).
 *   - Replaces the driver's implicit default of 30 s which produced
 *     the 40.7 s secureConnect observation on 2026-04-23 (see header).
 *
 * Applies to both `connection.ts` (Mongoose) and `mongoClient.ts`
 * (NextAuth raw driver). Kept tight on purpose: a failure here is
 * a specific-node problem, server selection should retry a sibling.
 */
export const MONGO_CONNECT_TIMEOUT_MS = 10_000

/**
 * Connection pool cap. Both clients use the same value today; surfaced
 * for consistency with the other timeouts.
 */
export const MONGO_MAX_POOL_SIZE = 10
