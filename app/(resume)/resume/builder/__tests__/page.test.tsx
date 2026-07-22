import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

const { searchState } = vi.hoisted(() => ({
  searchState: { params: new URLSearchParams() },
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => searchState.params,
}))
vi.mock('next-auth/react', () => ({
  useSession: () => ({ status: 'unauthenticated', data: null }),
}))
vi.mock('@shared/providers/AuthGateProvider', () => ({
  useAuthGate: () => ({ requireAuth: vi.fn() }),
}))
vi.mock('@resume/components/ResumeEditor', () => ({
  default: () => <div>Resume editor</div>,
}))

import ResumeBuilderPage from '../page'

const JOB_ID = '507f1f77bcf86cd799439011'

beforeEach(() => {
  searchState.params = new URLSearchParams()
  localStorage.clear()
})

describe('Resume Builder tracked-job return', () => {
  it('renders an exact same-job return action for a validated jobId', async () => {
    searchState.params = new URLSearchParams(`jobId=${JOB_ID}`)

    render(<ResumeBuilderPage />)

    expect(await screen.findByText('Resume editor')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Return to job application' })).toHaveAttribute(
      'href',
      `/jobs/${JOB_ID}?from=tailor#apply`,
    )
  })

  it('does not turn an arbitrary return value into a navigation target', async () => {
    searchState.params = new URLSearchParams('jobId=https://evil.example/steal')

    render(<ResumeBuilderPage />)

    expect(await screen.findByText('Resume editor')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Return to job application' })).toBeNull()
  })
})
