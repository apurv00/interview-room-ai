import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next-auth/react', () => ({
  useSession: () => ({
    data: {
      user: {
        id: '64b64c0f2f4e8b6a8c7d9e10',
        name: 'Plus Candidate',
        email: 'plus@example.com',
        plan: 'plus',
      },
    },
    status: 'authenticated',
  }),
  signOut: vi.fn(),
}))

vi.mock('@shared/providers/AuthGateProvider', () => ({
  useAuthGate: () => ({ open: vi.fn() }),
}))

import AuthMenu from '../AuthMenu'

describe('AuthMenu plan badge', () => {
  it('shows Plus accounts as Plus rather than the Free fallback', () => {
    render(<AuthMenu />)

    fireEvent.click(screen.getByRole('button'))

    expect(screen.getByText('Plus')).toBeInTheDocument()
    expect(screen.queryByText('Free')).not.toBeInTheDocument()
  })
})
