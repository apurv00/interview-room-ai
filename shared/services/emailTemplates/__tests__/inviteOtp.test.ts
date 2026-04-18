import { describe, it, expect } from 'vitest'
import { buildInviteOtpEmail } from '@shared/services/emailTemplates/inviteOtp'

describe('buildInviteOtpEmail', () => {
  it('includes the code in the subject, html body, and plain-text body', () => {
    const result = buildInviteOtpEmail({ code: '123456', expiryMinutes: 10 })
    expect(result.subject).toContain('123456')
    expect(result.html).toContain('123456')
    expect(result.text).toContain('123456')
  })

  it('HTML-escapes candidateName so a recruiter cannot inject scripts', () => {
    const result = buildInviteOtpEmail({
      code: '000000',
      candidateName: '<script>alert(1)</script>',
      expiryMinutes: 10,
    })
    expect(result.html).not.toContain('<script>')
    expect(result.html).toContain('&lt;script&gt;')
  })

  it('HTML-escapes orgName', () => {
    const result = buildInviteOtpEmail({
      code: '000000',
      orgName: 'Evil<img src=x onerror=alert(1)>',
      expiryMinutes: 10,
    })
    expect(result.html).not.toContain('<img')
    expect(result.html).toContain('&lt;img')
  })

  it("falls back to generic 'your interviewer' when orgName is absent", () => {
    const result = buildInviteOtpEmail({ code: '000000', expiryMinutes: 10 })
    expect(result.html).toContain('your interviewer')
  })

  it('uses the configured expiry window in both html and text', () => {
    const result = buildInviteOtpEmail({ code: '000000', expiryMinutes: 15 })
    expect(result.html).toContain('15 minutes')
    expect(result.text).toContain('15 minutes')
  })
})
