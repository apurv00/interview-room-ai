import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mintActionToken, verifyActionToken } from '../services/signedActionToken'

/**
 * EMAILS.md §4 invariants: dedicated secret, fail-closed, typed tokens
 * (unsub can never fire a status action), mandatory expiry, constant-time
 * verify, key rotation via v + EMAIL_TOKEN_SECRET_PREVIOUS.
 */

const SECRET = 'test-email-token-secret-with-adequate-length'

beforeEach(() => {
  vi.stubEnv('EMAIL_TOKEN_SECRET', SECRET)
  vi.unstubAllEnvs
})
afterEach(() => {
  vi.unstubAllEnvs()
})

const statusInput = { typ: 'status' as const, uid: 'u1', aid: 'app1', action: 'interview_scheduled', dk: 'app1:2026-07-20', expDays: 30 }

describe('signedActionToken', () => {
  it('mints and verifies a status token round-trip', () => {
    const token = mintActionToken(statusInput)
    const res = verifyActionToken(token, 'status')
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.payload).toMatchObject({ typ: 'status', uid: 'u1', aid: 'app1', action: 'interview_scheduled', dk: 'app1:2026-07-20', v: 1 })
      expect(res.payload.exp).toBeGreaterThan(Date.now() / 1000)
    }
  })

  it('FAILS CLOSED with no secret: mint throws, verify rejects — no dev fallback', () => {
    vi.stubEnv('EMAIL_TOKEN_SECRET', '')
    expect(() => mintActionToken(statusInput)).toThrow(/EMAIL_TOKEN_SECRET/)
    expect(verifyActionToken('whatever.sig', 'status')).toEqual({ ok: false, reason: 'unconfigured' })
  })

  it('type separation: an unsub token can never fire a status action (and vice versa)', () => {
    const unsub = mintActionToken({ typ: 'unsub', uid: 'u1', action: 'all', expDays: 365 })
    expect(verifyActionToken(unsub, 'status')).toEqual({ ok: false, reason: 'wrong-type' })
    const status = mintActionToken(statusInput)
    expect(verifyActionToken(status, 'unsub')).toEqual({ ok: false, reason: 'wrong-type' })
  })

  it('tampering with payload or signature invalidates', () => {
    const token = mintActionToken(statusInput)
    const [p, s] = token.split('.')
    // Forge the payload (swap the uid) but keep the old signature.
    const forged = JSON.parse(Buffer.from(p, 'base64url').toString())
    forged.uid = 'attacker'
    const forgedB64 = Buffer.from(JSON.stringify(forged)).toString('base64url')
    expect(verifyActionToken(`${forgedB64}.${s}`, 'status').ok).toBe(false)
    // Corrupt the signature.
    expect(verifyActionToken(`${p}.${s.slice(0, -2)}xx`, 'status').ok).toBe(false)
    // Garbage shapes.
    expect(verifyActionToken('', 'status').ok).toBe(false)
    expect(verifyActionToken('no-dot-here', 'status').ok).toBe(false)
    expect(verifyActionToken('a.', 'status').ok).toBe(false)
  })

  it('expiry is mandatory and enforced: expired and exp-less tokens both reject', () => {
    const expired = mintActionToken({ ...statusInput, expDays: -1 })
    expect(verifyActionToken(expired, 'status')).toEqual({ ok: false, reason: 'expired' })
    // Hand-craft a validly-signed token WITHOUT exp — must never verify.
    const { createHmac } = require('crypto') as typeof import('crypto')
    const payload = { v: 1, typ: 'status', uid: 'u1', action: 'x' } // no exp
    const pB64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const sig = createHmac('sha256', SECRET).update(pB64).digest().toString('base64url')
    expect(verifyActionToken(`${pB64}.${sig}`, 'status')).toEqual({ ok: false, reason: 'expired' })
  })

  it('key rotation: v2 verifies against EMAIL_TOKEN_SECRET_PREVIOUS; unknown v rejects', () => {
    const OLD = 'the-previous-secret-before-rotation'
    vi.stubEnv('EMAIL_TOKEN_SECRET_PREVIOUS', OLD)
    const { createHmac } = require('crypto') as typeof import('crypto')
    const payload = { v: 2, typ: 'status', uid: 'u1', action: 'x', exp: Math.floor(Date.now() / 1000) + 3600 }
    const pB64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const sigOld = createHmac('sha256', OLD).update(pB64).digest().toString('base64url')
    expect(verifyActionToken(`${pB64}.${sigOld}`, 'status').ok).toBe(true)
    // Same payload signed with the CURRENT secret but claiming v2 → invalid.
    const sigNew = createHmac('sha256', SECRET).update(pB64).digest().toString('base64url')
    expect(verifyActionToken(`${pB64}.${sigNew}`, 'status').ok).toBe(false)
    // Unknown key id.
    const p3 = Buffer.from(JSON.stringify({ ...payload, v: 9 })).toString('base64url')
    const sig3 = createHmac('sha256', SECRET).update(p3).digest().toString('base64url')
    expect(verifyActionToken(`${p3}.${sig3}`, 'status').ok).toBe(false)
  })

  it('mint always uses v1 (current key) — rotation grace is verify-only', () => {
    vi.stubEnv('EMAIL_TOKEN_SECRET_PREVIOUS', 'old-key')
    const token = mintActionToken(statusInput)
    const res = verifyActionToken(token, 'status')
    expect(res.ok && res.payload.v).toBe(1)
  })
})
