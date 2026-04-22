/**
 * @vitest-environment node
 *
 * Pins the shared-constant contract that fixes the P0 bug from the
 * 2026-04-22 session 69e8f4eb diagnostic run:
 *
 *   `shared/db/mongoClient.ts` (NextAuth's raw MongoDB driver client)
 *   had `serverSelectionTimeoutMS: 5000` while
 *   `shared/db/connection.ts` (Mongoose for app data) had `15000`.
 *
 *   Atlas M0 cold-wake latency of 10-15s put the NextAuth client
 *   under its limit while the app client survived — producing a
 *   split-brain where /api/auth/session failed silently (returned
 *   200 with no session) while same-cluster app routes succeeded.
 *
 * These tests guard against:
 *   1. Someone lowering the timeout below 10s (the M0 minimum safe).
 *   2. Someone re-hardcoding a literal in either file and skipping
 *      the shared module (regression via copy-paste).
 *
 * File-content assertions use `Read` (fs) rather than parsing the TS,
 * because we want a lexical check — a regex match for the import keeps
 * us from false-negatives on dynamic config patterns.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
  MONGO_MAX_POOL_SIZE,
  MONGO_SERVER_SELECTION_TIMEOUT_MS,
  MONGO_SOCKET_TIMEOUT_MS,
} from '../db/mongoConfig'

describe('MONGO_SERVER_SELECTION_TIMEOUT_MS', () => {
  it('is at least 10s — below this, M0 cold-wake failures return', () => {
    // Atlas M0 (shared free tier) can take 10-15s to wake from idle.
    // Lowering the timeout below 10s risks reintroducing the P0 that
    // was observed on 2026-04-22: bursts of
    // `MongoServerSelectionError: Server selection timed out after
    // 5000 ms` on /api/auth/session during Atlas wake-up windows.
    expect(MONGO_SERVER_SELECTION_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000)
  })

  it('is exactly 15000 (current agreed value)', () => {
    // Regression guard for the specific fix landed 2026-04-22. Bumping
    // this intentionally is fine — intentional CHANGE should update
    // both this test and the constant together.
    expect(MONGO_SERVER_SELECTION_TIMEOUT_MS).toBe(15_000)
  })
})

describe('MONGO_SOCKET_TIMEOUT_MS', () => {
  it('is 45000 (current agreed value, unchanged by the P0 fix)', () => {
    expect(MONGO_SOCKET_TIMEOUT_MS).toBe(45_000)
  })
})

describe('MONGO_MAX_POOL_SIZE', () => {
  it('is 10 (current agreed value)', () => {
    expect(MONGO_MAX_POOL_SIZE).toBe(10)
  })
})

describe('driver-config centralisation', () => {
  // These lexical checks catch the exact regression the refactor
  // prevents: a future edit copy-pasting a literal timeout into either
  // driver file instead of importing from mongoConfig.ts. If someone
  // adds a SECOND `serverSelectionTimeoutMS:` call site, this fails.

  it('mongoClient.ts imports MONGO_SERVER_SELECTION_TIMEOUT_MS (no literal)', () => {
    const src = readFileSync(
      resolve(__dirname, '../db/mongoClient.ts'),
      'utf8',
    )
    expect(src).toContain('MONGO_SERVER_SELECTION_TIMEOUT_MS')
    // No hardcoded literal on a `serverSelectionTimeoutMS: <number>` line.
    expect(src).not.toMatch(/serverSelectionTimeoutMS\s*:\s*\d/)
  })

  it('connection.ts imports MONGO_SERVER_SELECTION_TIMEOUT_MS (no literal)', () => {
    const src = readFileSync(
      resolve(__dirname, '../db/connection.ts'),
      'utf8',
    )
    expect(src).toContain('MONGO_SERVER_SELECTION_TIMEOUT_MS')
    expect(src).not.toMatch(/serverSelectionTimeoutMS\s*:\s*\d/)
  })

  it('mongoClient.ts imports MONGO_MAX_POOL_SIZE (no literal)', () => {
    const src = readFileSync(
      resolve(__dirname, '../db/mongoClient.ts'),
      'utf8',
    )
    expect(src).toContain('MONGO_MAX_POOL_SIZE')
    expect(src).not.toMatch(/maxPoolSize\s*:\s*\d/)
  })

  it('connection.ts imports MONGO_MAX_POOL_SIZE and MONGO_SOCKET_TIMEOUT_MS (no literals)', () => {
    const src = readFileSync(
      resolve(__dirname, '../db/connection.ts'),
      'utf8',
    )
    expect(src).toContain('MONGO_MAX_POOL_SIZE')
    expect(src).toContain('MONGO_SOCKET_TIMEOUT_MS')
    expect(src).not.toMatch(/maxPoolSize\s*:\s*\d/)
    expect(src).not.toMatch(/socketTimeoutMS\s*:\s*\d/)
  })
})
