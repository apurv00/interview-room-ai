/**
 * @vitest-environment node
 *
 * Covers the `connectDBIfNeeded` wrapper added in Phase 1 PR C. The
 * actual `connectDB()` implementation uses mongoose + network sockets
 * and isn't unit-testable here; we mock it via vi.mock to verify the
 * WRAPPER's routing logic (flag check + needsMongo gate).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.mock factories run BEFORE top-level const declarations (vitest
// hoists them above imports). Using vi.hoisted() to declare the mock
// functions ensures they exist before the factories reference them.
const { mockIsFeatureEnabled, mockAiLoggerInfo } = vi.hoisted(() => ({
  mockIsFeatureEnabled: vi.fn(),
  mockAiLoggerInfo: vi.fn(),
}))

// Intercept the mongoose-backed `connectDB` so tests don't open TCP.
// The wrapper is what we're actually testing — we only need to verify
// whether it delegated to connectDB (→ mongoose.connect was called) or
// skipped (→ mongoose.connect was NOT called).
vi.mock('mongoose', () => ({
  default: {
    connect: vi.fn().mockResolvedValue({}),
    connection: { readyState: 1 },
  },
}))

vi.mock('@shared/featureFlags', () => ({
  isFeatureEnabled: mockIsFeatureEnabled,
}))

vi.mock('@shared/logger', () => ({
  aiLogger: { info: mockAiLoggerInfo, warn: vi.fn(), error: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// Import AFTER mocks. We also spy on connectDB by replacing the named
// export in the module; simplest way is to import the module namespace
// and override connectDB on it. But the wrapper calls connectDB from
// the SAME module (lexical reference, not re-imported), so we have to
// test via observable side effects of the wrapper — did `mongoose.connect`
// get called or not?
import { connectDBIfNeeded } from '@shared/db/connection'
import mongoose from 'mongoose'

describe('connectDBIfNeeded (Phase 1 PR C)', () => {
  beforeEach(() => {
    vi.mocked(mongoose.connect).mockReset()
    vi.mocked(mongoose.connect).mockResolvedValue({} as never)
    mockIsFeatureEnabled.mockReset()
    mockAiLoggerInfo.mockReset()
    // connection.ts captures `const cached = globalThis.mongoose` once at
    // module load. Reassigning `global.mongoose = {...}` creates a new
    // object but the module's `cached` still points at the old one, so
    // the cache leaks across tests (conn stays populated). Mutate the
    // existing object in place so the same reference is cleared.
    const cache = (global as unknown as { mongoose?: { conn: unknown; promise: unknown } }).mongoose
    if (cache) {
      cache.conn = null
      cache.promise = null
    }
    // MONGODB_URI must be present for connectDB to attempt a connect.
    process.env.MONGODB_URI = 'mongodb://localhost/test'
  })

  it('calls connectDB when needsMongo is true, regardless of flag', async () => {
    mockIsFeatureEnabled.mockReturnValue(false)
    await connectDBIfNeeded(true, 'test-ctx')
    expect(mongoose.connect).toHaveBeenCalledTimes(1)
    expect(mockAiLoggerInfo).not.toHaveBeenCalled()
  })

  it('calls connectDB when flag is OFF, even if needsMongo=false (safe default)', async () => {
    // Old-behavior guarantee: when the flag is off, the wrapper is
    // equivalent to the bare `await connectDB()` call it replaced.
    // A regression here would silently regress every route that routes
    // through the wrapper.
    mockIsFeatureEnabled.mockReturnValue(false)
    await connectDBIfNeeded(false, 'test-ctx')
    expect(mongoose.connect).toHaveBeenCalledTimes(1)
    expect(mockAiLoggerInfo).not.toHaveBeenCalled()
  })

  it('skips connectDB AND emits bypass log when flag ON + needsMongo=false', async () => {
    mockIsFeatureEnabled.mockReturnValue(true)
    await connectDBIfNeeded(false, 'test-ctx')
    expect(mongoose.connect).not.toHaveBeenCalled()
    expect(mockAiLoggerInfo).toHaveBeenCalledTimes(1)
    const [payload, msg] = mockAiLoggerInfo.mock.calls[0] as [
      { event: string; context: string },
      string,
    ]
    expect(payload.event).toBe('connectdb_bypass')
    expect(payload.context).toBe('test-ctx')
    expect(msg).toContain('connectDB skipped')
  })

  it('checks the correct feature flag key', async () => {
    mockIsFeatureEnabled.mockReturnValue(false)
    await connectDBIfNeeded(false, 'test-ctx')
    expect(mockIsFeatureEnabled).toHaveBeenCalledWith('skip_connectdb_when_cached')
  })

  it('emits connectdb_needed diagnostic when flag ON + needsMongo=true (telemetry 2026-04-21)', async () => {
    // The case the diagnostic was built for: flag flipped ON in prod
    // but no `event:connectdb_bypass` appearing in logs. This event
    // answers "which field was null — why did we still need Mongo?"
    mockIsFeatureEnabled.mockReturnValue(true)
    await connectDBIfNeeded(true, 'generate-question:user-profile', 'userProfile-null')
    expect(mongoose.connect).toHaveBeenCalledTimes(1)
    const needed = mockAiLoggerInfo.mock.calls.find(
      ([p]) => (p as { event?: string }).event === 'connectdb_needed',
    )
    expect(needed).toBeDefined()
    const [payload, msg] = needed as [
      { event: string; context: string; reason: string },
      string,
    ]
    expect(payload.context).toBe('generate-question:user-profile')
    expect(payload.reason).toBe('userProfile-null')
    expect(msg).toContain('connectDB called despite skip flag')
  })

  it('defaults needReason to "unspecified" when caller omits it', async () => {
    // Back-compat: old call sites that pass only two args still work.
    mockIsFeatureEnabled.mockReturnValue(true)
    await connectDBIfNeeded(true, 'legacy-caller')
    const needed = mockAiLoggerInfo.mock.calls.find(
      ([p]) => (p as { event?: string }).event === 'connectdb_needed',
    )
    expect(needed).toBeDefined()
    const [payload] = needed as [{ reason: string }, string]
    expect(payload.reason).toBe('unspecified')
  })

  it('does NOT emit connectdb_needed when flag is OFF — that case is not a data problem', async () => {
    // The flag-off case means "rollout not started yet", not "cache
    // misconfigured". Logging every connect would flood pino with
    // useless lines during gradual rollout.
    mockIsFeatureEnabled.mockReturnValue(false)
    await connectDBIfNeeded(true, 'pre-rollout-caller', 'whatever-null')
    expect(mongoose.connect).toHaveBeenCalledTimes(1)
    const needed = mockAiLoggerInfo.mock.calls.find(
      ([p]) => (p as { event?: string }).event === 'connectdb_needed',
    )
    expect(needed).toBeUndefined()
  })
})
