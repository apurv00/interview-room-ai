/**
 * Engine-seam contract tests (goal item 2).
 *
 * The hire module consumes the interview engine WITHOUT modifying it, so the
 * seams live on conventions this suite pins. If the engine ever changes its
 * public contracts — the CreateSessionSchema config shape, the localStorage
 * key names, or the depth catalog — these tests fail loudly instead of the
 * guest flow silently breaking in production.
 */

import { describe, it, expect } from 'vitest'
import { CreateSessionSchema } from '@interview/validators/interview'
import { isDepthAllowedForExperience } from '@interview'
import { STORAGE_KEYS } from '@shared/storageKeys'
import { AI_ROUND_INTERVIEW_TYPE, GuestConsentSchema, GuestVerifyOtpSchema } from '..'
import type { GuestInterviewConfig } from '../services/aiRoundService'

describe('session-provisioning seam: the engine accepts the guest config', () => {
  const guestConfig: GuestInterviewConfig = {
    role: 'Backend Engineer',
    interviewType: AI_ROUND_INTERVIEW_TYPE,
    experience: '3-6',
    duration: 15,
    jobDescription: 'We are hiring a backend engineer to build our core platform APIs.',
    targetCompany: 'Acme Inc.',
  }

  it("CreateSessionSchema (the engine's POST /api/interviews contract) parses it", () => {
    const parsed = CreateSessionSchema.parse({ config: guestConfig })
    expect(parsed.config.role).toBe('Backend Engineer')
    expect(parsed.config.interviewType).toBe(AI_ROUND_INTERVIEW_TYPE)
    expect(parsed.config.duration).toBe(15)
    expect(parsed.config.jobDescription).toContain('backend engineer')
  })

  it('both send-modal durations pass the engine contract', () => {
    for (const duration of [15, 30]) {
      expect(() => CreateSessionSchema.parse({ config: { ...guestConfig, duration } })).not.toThrow()
    }
  })

  it('the fixed AI-round depth is allowed at every experience band', () => {
    for (const experience of ['0-2', '3-6', '7+']) {
      expect(isDepthAllowedForExperience(AI_ROUND_INTERVIEW_TYPE, experience)).toBe(true)
    }
  })
})

describe('localStorage handoff contract (prepare page ↔ engine room)', () => {
  it('pins the key names the engine room reads', () => {
    // app/candidate/[roundId]/prepare/page.tsx writes these; the engine's
    // /interview page reads them. A rename on either side must break here.
    expect(STORAGE_KEYS.INTERVIEW_CONFIG).toBe('interviewConfig')
    expect(STORAGE_KEYS.INTERVIEW_ACTIVE_SESSION).toBe('interviewActiveSession')
    expect(STORAGE_KEYS.PENDING_RETAKE_PARENT).toBe('pendingRetakeParent')
    expect(STORAGE_KEYS.INTERVIEW_DATA).toBe('interviewData')
  })
})

describe('guest token contract', () => {
  it('accepts exactly 32-byte hex tokens', () => {
    expect(() => GuestConsentSchema.parse({ token: 'ab'.repeat(32) })).not.toThrow()
    expect(() => GuestConsentSchema.parse({ token: 'ab'.repeat(31) })).toThrow()
    expect(() => GuestConsentSchema.parse({ token: 'zz'.repeat(32) })).toThrow()
  })

  it('requires a 6-digit numeric OTP', () => {
    const base = { token: 'ab'.repeat(32), email: 'a@b.com' }
    expect(() => GuestVerifyOtpSchema.parse({ ...base, code: '123456' })).not.toThrow()
    expect(() => GuestVerifyOtpSchema.parse({ ...base, code: '12345' })).toThrow()
    expect(() => GuestVerifyOtpSchema.parse({ ...base, code: 'abcdef' })).toThrow()
  })
})
