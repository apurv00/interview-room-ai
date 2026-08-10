import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MembersPage from '../page'

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('pending Hire member setup recovery', () => {
  it('lets an admin regenerate an unreachable setup credential after reload', async () => {
    const memberId = '222222222222222222222222'
    const setupUrl =
      'https://hire.interviewprep.guru/hire-signin#setup=111111111111111111111111.secret'
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/workspace/members') {
        return json({
          members: [
            {
              id: memberId,
              email: 'pending@acme.com',
              name: 'Pending Person',
              role: 'member',
              linked: false,
              authState: 'pending',
              passwordSet: false,
              addedAt: '2026-08-10T00:00:00.000Z',
            },
          ],
        })
      }
      if (url === '/api/workspace') {
        return json({
          workspace: {
            id: '111111111111111111111111',
            name: 'Acme',
            guestAuthMode: 'magic_link',
            lifecycleState: 'active',
            deletedAt: null,
            purgeAfter: null,
            deletedByName: null,
          },
          membership: {
            id: '333333333333333333333333',
            email: 'admin@acme.com',
            role: 'admin',
            directAccount: true,
          },
        })
      }
      if (url === `/api/workspace/members/${memberId}/setup`) {
        expect(init?.method).toBe('POST')
        return json({
          credentialSetup: {
            url: setupUrl,
            expiresAt: '2026-08-11T00:00:00.000Z',
            emailSent: false,
          },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<MembersPage />)

    fireEvent.click(
      await screen.findByRole('button', { name: 'Regenerate setup link' }),
    )

    expect(
      await screen.findByText(/New setup link created for Pending Person/),
    ).toHaveTextContent('Email delivery failed — share the new link manually.')
    expect(
      screen.getByRole('button', { name: 'Copy new password setup link' }),
    ).toBeInTheDocument()
  })
})
