import { afterEach, describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import {
  hasTrustedOrigin,
  hasTrustedOriginForMutation,
} from '../_lib/request'

const ORIGINAL_NODE_ENV = process.env.NODE_ENV
const ORIGINAL_HIRE_PUBLIC_URL = process.env.HIRE_PUBLIC_URL

function request(method: string, origin?: string): NextRequest {
  return new NextRequest(
    'https://hire.interviewprep.guru/api/workspace/members',
    {
      method,
      ...(origin ? { headers: { origin } } : {}),
    },
  )
}

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV
  if (ORIGINAL_HIRE_PUBLIC_URL === undefined) {
    delete process.env.HIRE_PUBLIC_URL
  } else {
    process.env.HIRE_PUBLIC_URL = ORIGINAL_HIRE_PUBLIC_URL
  }
})

describe('Hire trusted Origin boundary', () => {
  it('accepts only the exact configured production Hire origin', () => {
    process.env.NODE_ENV = 'production'
    process.env.HIRE_PUBLIC_URL = 'https://hire.interviewprep.guru/workspace'

    expect(
      hasTrustedOrigin(
        request('POST', 'https://hire.interviewprep.guru'),
      ),
    ).toBe(true)
    expect(
      hasTrustedOrigin(
        request('POST', 'https://evil.interviewprep.guru'),
      ),
    ).toBe(false)
    expect(
      hasTrustedOrigin(
        request('POST', 'https://hire.interviewprep.guru/forged-path'),
      ),
    ).toBe(false)
  })

  it('rejects missing Origin on every non-safe production method', () => {
    process.env.NODE_ENV = 'production'

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(hasTrustedOriginForMutation(request(method))).toBe(false)
    }
  })

  it('does not require Origin for safe production methods', () => {
    process.env.NODE_ENV = 'production'

    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(hasTrustedOriginForMutation(request(method))).toBe(true)
    }
  })

  it('preserves missing-Origin tests and explicit localhost development calls', () => {
    process.env.NODE_ENV = 'test'

    expect(hasTrustedOriginForMutation(request('POST'))).toBe(true)
    expect(hasTrustedOrigin(request('POST', 'http://localhost:3000'))).toBe(true)
    expect(hasTrustedOrigin(request('POST', 'https://hire.interviewprep.guru'))).toBe(false)
  })
})
