import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Security retrofit (2026-07-15): the learn unsubscribe route accepted a
 * RAW unauthenticated userId and MUTATED ON GET — an IDOR any link-scanner
 * could trigger. Now signed-token only (the jobs-wave helper), GET
 * confirms, POST commits. Real tokens against a stubbed secret so the
 * verify path is exercised for real.
 */

const { mockUserUpdateOne } = vi.hoisted(() => ({ mockUserUpdateOne: vi.fn() }))

vi.mock('@shared/db/connection', () => ({ connectDB: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@shared/db/models', () => ({ User: { updateOne: mockUserUpdateOne } }))

import { GET, POST } from '../../../app/api/learn/unsubscribe/route'
import { mintActionToken } from '@shared/services/signedActionToken'

const req = (qs: string, method = 'POST') => new Request(`http://x/api/learn/unsubscribe?${qs}`, { method })
const tok = (action: string) => mintActionToken({ typ: 'unsub', uid: '507f1f77bcf86cd799439011', action, expDays: 365 })

beforeEach(() => {
  vi.stubEnv('EMAIL_TOKEN_SECRET', 'learn-unsub-test-secret')
  vi.clearAllMocks()
  mockUserUpdateOne.mockResolvedValue({})
})

describe('learn unsubscribe (signed tokens only)', () => {
  it('the LEGACY raw-userId contract is dead: no mutation, no user-existence oracle', async () => {
    for (const method of [GET, POST]) {
      const res = await method(req('userId=507f1f77bcf86cd799439011&type=digest'))
      expect(await res.text()).toContain("isn't valid")
      expect(mockUserUpdateOne).not.toHaveBeenCalled()
    }
  })

  it('GET with a valid token renders a confirm form and NEVER mutates (scanner-safe)', async () => {
    const res = await GET(req(`token=${encodeURIComponent(tok('learn-digest'))}`, 'GET'))
    const html = await res.text()
    expect(html).toContain('<form method="POST"')
    expect(html).toContain('digest emails')
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(mockUserUpdateOne).not.toHaveBeenCalled()
  })

  it('POST with a valid token flips exactly the scoped preference', async () => {
    await POST(req(`token=${encodeURIComponent(tok('learn-digest'))}`))
    expect(mockUserUpdateOne).toHaveBeenCalledWith(
      { _id: '507f1f77bcf86cd799439011' },
      { $set: { 'emailPreferences.digest': false } }
    )
    vi.clearAllMocks()
    mockUserUpdateOne.mockResolvedValue({})
    await POST(req(`token=${encodeURIComponent(tok('learn-reminders'))}`))
    expect(mockUserUpdateOne).toHaveBeenCalledWith(
      { _id: '507f1f77bcf86cd799439011' },
      { $set: { 'emailPreferences.reminders': false } }
    )
  })

  it('cross-scope tokens are rejected: a jobs unsub token cannot flip learn prefs, and vice versa', async () => {
    const jobsToken = mintActionToken({ typ: 'unsub', uid: '507f1f77bcf86cd799439011', action: 'e1', expDays: 365 })
    const res = await POST(req(`token=${encodeURIComponent(jobsToken)}`))
    expect(await res.text()).toContain("isn't valid")
    expect(mockUserUpdateOne).not.toHaveBeenCalled()
    // status-purpose tokens are rejected outright by typ separation
    const statusToken = mintActionToken({ typ: 'status', uid: 'u', aid: 'a', action: 'rejected', expDays: 30 })
    expect(await (await POST(req(`token=${encodeURIComponent(statusToken)}`))).text()).toContain("isn't valid")
  })

  it('tampered and expired tokens are rejected without mutation', async () => {
    const t = tok('learn-digest')
    const res = await POST(req(`token=${encodeURIComponent(t.slice(0, -4) + 'AAAA')}`))
    expect(await res.text()).toContain("isn't valid")
    const expired = mintActionToken({ typ: 'unsub', uid: '507f1f77bcf86cd799439011', action: 'learn-digest', expDays: -1 })
    expect(await (await POST(req(`token=${encodeURIComponent(expired)}`))).text()).toContain("isn't valid")
    expect(mockUserUpdateOne).not.toHaveBeenCalled()
  })
})
