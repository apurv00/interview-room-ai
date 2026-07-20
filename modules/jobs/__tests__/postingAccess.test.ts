import { describe, expect, it } from 'vitest'
import { jobPostingStateOf } from '../services/postingAccess'

describe('jobPostingStateOf', () => {
  it('keeps only normal lifecycle closures preparation-capable', () => {
    expect(jobPostingStateOf({ status: 'open' } as never)).toBe('live')
    for (const closedReason of ['board-poll-miss', 'valid-through-expired', 'aged-out', 'dead-apply-link'] as const) {
      expect(jobPostingStateOf({ status: 'closed', closedReason } as never)).toBe('archived')
    }
  })

  it('fails closed for safety/legal and unknown legacy removals', () => {
    expect(jobPostingStateOf({ status: 'closed', closedReason: 'source-revoked' } as never)).toBe('restricted')
    expect(jobPostingStateOf({ status: 'closed', closedReason: 'llm-verdict' } as never)).toBe('restricted')
    expect(jobPostingStateOf({ status: 'closed' } as never)).toBe('restricted')
  })
})
