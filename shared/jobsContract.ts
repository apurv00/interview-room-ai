/**
 * Cross-layer persistence limits for the Jobs application contract.
 *
 * Keep this outside the Mongoose model so API handlers and client-side
 * recovery code enforce the same boundary before a database write is tried.
 */
export const MAX_JOB_TAILORED_TEXT_CHARS = 60_000
