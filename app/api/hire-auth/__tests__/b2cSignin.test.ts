import { afterEach, describe, expect, it, vi } from 'vitest'
import { GET } from '../b2c-signin/route'

afterEach(() => vi.unstubAllEnvs())

describe('GET /api/hire-auth/b2c-signin', () => {
  it('moves authentication to www and returns to the isolated Hire workspace', async () => {
    vi.stubEnv('B2C_PUBLIC_URL', 'https://www.interviewprep.guru')
    vi.stubEnv('HIRE_PUBLIC_URL', 'https://hire.interviewprep.guru')
    const response = await GET()
    const location = new URL(response.headers.get('location')!)
    expect(location.origin).toBe('https://www.interviewprep.guru')
    expect(location.pathname).toBe('/signin')
    expect(location.searchParams.get('callbackUrl')).toBe(
      'https://hire.interviewprep.guru/workspace',
    )
  })

  it('fails closed to first-party origins for poisoned environment values', async () => {
    vi.stubEnv('B2C_PUBLIC_URL', 'https://evil.example')
    vi.stubEnv('HIRE_PUBLIC_URL', 'javascript:alert(1)')
    const response = await GET()
    const location = new URL(response.headers.get('location')!)
    expect(location.origin).toBe('https://www.interviewprep.guru')
    expect(location.searchParams.get('callbackUrl')).toBe(
      'https://hire.interviewprep.guru/workspace',
    )
  })
})
