import { describe, expect, it } from 'vitest'
import { buildHireDailyDigestEmail } from '../emails/hireDailyDigestEmail'

describe('Hire daily digest email', () => {
  it('renders only escaped aggregate operational counts and an authenticated overview link', () => {
    const email = buildHireDailyDigestEmail({
      recipientName: '<member>',
      payload: {
        workspaceName: '<Acme & Co>',
        generatedAt: new Date('2026-08-14T09:00:00.000Z'),
        openJobs: 2,
        awaitingDecision: 3,
        pendingScorecards: 1,
        terminalKitDeliveryFailures: 4,
        validationAttentionInterviews: 2,
      },
    })
    expect(email.subject).toBe('<Acme & Co>: daily hiring summary')
    expect(email.html).toContain('Hi &lt;member&gt;')
    expect(email.html).toContain('&lt;Acme &amp; Co&gt;')
    expect(email.html).toContain('/workspace/overview')
    expect(email.html).not.toContain('candidate@example.com')
    expect(email.text).toContain('2 open jobs')
    expect(email.text).toContain('2 interview validation timelines available')
    expect(email.text).not.toMatch(/resume|transcript|capability|report attachment|candidate email/i)
  })

  it('does not invent a zero validation count for a legacy pending snapshot', () => {
    const email = buildHireDailyDigestEmail({
      recipientName: 'Member',
      payload: {
        workspaceName: 'Acme',
        generatedAt: new Date('2026-08-14T09:00:00.000Z'),
        openJobs: 1,
        awaitingDecision: 0,
        pendingScorecards: 0,
        terminalKitDeliveryFailures: 0,
      },
    })

    expect(email.text).not.toMatch(/validation timeline/i)
    expect(email.html).not.toMatch(/validation timeline/i)
  })
})
