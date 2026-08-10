import { describe, expect, it, vi } from 'vitest'
import {
  createInternalServiceHeaders,
  type InternalServiceReplayStore,
  verifyInternalServiceRequest,
} from '../internalServiceAuth'

const KEY = { keyId: 'test-key', secret: 's'.repeat(64) }
const NOW = new Date('2026-08-10T00:00:00.000Z')
const NONCE = 'a'.repeat(64)
const BODY = JSON.stringify({ roundId: 'b'.repeat(24) })
const PATH = '/api/internal/hire/engine/results'

function headers(body = BODY, now = NOW) {
  return createInternalServiceHeaders({
    method: 'POST',
    path: PATH,
    body,
    key: KEY,
    now,
    nonce: NONCE,
  })
}

describe('internal service HMAC', () => {
  it('authenticates the exact method, path, timestamp, nonce, and body', async () => {
    const replayStore: InternalServiceReplayStore = { claim: vi.fn().mockResolvedValue(true) }
    const result = await verifyInternalServiceRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      headers: headers(),
      keys: [KEY],
      replayStore,
      now: NOW,
    })
    expect(result).toMatchObject({ ok: true, keyId: KEY.keyId, nonce: NONCE })
    expect(replayStore.claim).toHaveBeenCalledOnce()
  })

  it('rejects body tampering before claiming a replay nonce', async () => {
    const replayStore: InternalServiceReplayStore = { claim: vi.fn().mockResolvedValue(true) }
    const result = await verifyInternalServiceRequest({
      method: 'POST',
      path: PATH,
      body: `${BODY} `,
      headers: headers(),
      keys: [KEY],
      replayStore,
      now: NOW,
    })
    expect(result).toEqual({ ok: false, reason: 'invalid-signature' })
    expect(replayStore.claim).not.toHaveBeenCalled()
  })

  it('rejects stale timestamps', async () => {
    const replayStore: InternalServiceReplayStore = { claim: vi.fn().mockResolvedValue(true) }
    const result = await verifyInternalServiceRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      headers: headers(BODY, new Date('2026-08-09T23:58:00.000Z')),
      keys: [KEY],
      replayStore,
      now: NOW,
    })
    expect(result).toEqual({ ok: false, reason: 'expired' })
  })

  it('fails closed on nonce replay and replay-store failure', async () => {
    const replayed = await verifyInternalServiceRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      headers: headers(),
      keys: [KEY],
      replayStore: { claim: vi.fn().mockResolvedValue(false) },
      now: NOW,
    })
    expect(replayed).toEqual({ ok: false, reason: 'replayed' })

    const unavailable = await verifyInternalServiceRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      headers: headers(),
      keys: [KEY],
      replayStore: { claim: vi.fn().mockRejectedValue(new Error('down')) },
      now: NOW,
    })
    expect(unavailable).toEqual({ ok: false, reason: 'replay-store-unavailable' })
  })
})
