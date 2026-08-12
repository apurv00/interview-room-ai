import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveFirstPartyAuthRedirect } from '../redirect'

afterEach(() => vi.unstubAllEnvs())

describe('shared first-party auth redirect', () => {
  it('allows B2C sign-in to return to the Hire control subdomain', () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect(
      resolveFirstPartyAuthRedirect(
        'https://hire.interviewprep.guru/workspace',
        'https://www.interviewprep.guru',
      ),
    ).toBe('https://hire.interviewprep.guru/workspace')
  })

  it('rejects lookalike, insecure, and malformed callbacks', () => {
    vi.stubEnv('NODE_ENV', 'production')
    const base = 'https://www.interviewprep.guru'
    expect(resolveFirstPartyAuthRedirect('https://interviewprep.guru.evil.example/x', base)).toBe(base)
    expect(resolveFirstPartyAuthRedirect('http://hire.interviewprep.guru/x', base)).toBe(base)
    expect(resolveFirstPartyAuthRedirect('https://%', base)).toBe(base)
  })

  it('keeps the isolated runtime same-origin only', () => {
    vi.stubEnv('NODE_ENV', 'production')
    const base = 'https://engine.hire.interviewprep.guru'
    expect(resolveFirstPartyAuthRedirect('/lobby', base, true)).toBe(`${base}/lobby`)
    expect(
      resolveFirstPartyAuthRedirect('https://hire.interviewprep.guru/workspace', base, true),
    ).toBe(base)
  })
})
