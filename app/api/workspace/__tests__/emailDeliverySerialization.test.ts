import { describe, expect, it } from 'vitest'
import { serializeJobEmailDelivery } from '../_lib/serialize'

describe('job email delivery API serialization', () => {
  it('returns only member-facing delivery fields', () => {
    const failedAt = new Date('2026-08-10T11:00:00.000Z')
    const serialized = serializeJobEmailDelivery({
      total: 2,
      pending: 0,
      sending: 0,
      sent: 1,
      failed: 1,
      failures: [
        {
          recipientEmail: 'candidate@example.com',
          recipientName: 'Candidate One',
          attempts: 5,
          lastError: 'Provider did not accept the message',
          failedAt,
          claimToken: 'must-not-leak',
          providerMessageId: 'must-not-leak',
          payload: { decisionNote: 'must-not-leak' },
        },
      ],
    } as never)

    expect(serialized).toEqual({
      total: 2,
      pending: 0,
      sending: 0,
      sent: 1,
      failed: 1,
      failures: [
        {
          recipientEmail: 'candidate@example.com',
          recipientName: 'Candidate One',
          attempts: 5,
          lastError: 'Provider did not accept the message',
          failedAt,
        },
      ],
    })
    expect(JSON.stringify(serialized)).not.toContain('must-not-leak')
  })
})
