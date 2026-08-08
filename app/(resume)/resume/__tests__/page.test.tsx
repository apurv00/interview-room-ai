import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sessionState = vi.hoisted(() => ({
  value: {
    status: 'authenticated' as const,
    data: { user: { id: 'user-1' } },
  },
}))

vi.mock('next-auth/react', () => ({
  useSession: () => sessionState.value,
}))

import ResumeDashboardPage from '../page'

const resume = {
  id: 'resume-1',
  name: 'Product resume',
  template: 'professional',
  targetRole: 'Product Manager',
  targetCompany: '',
  atsScore: null,
  updatedAt: '2026-08-07T00:00:00.000Z',
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('resume purchase protection', () => {
  it('marks and disables deletion for the exact purchased resume', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      resumes: [{ ...resume, protectedByPurchase: true }],
      count: 1,
      limit: 1,
      hasProfile: true,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    render(<ResumeDashboardPage />)

    expect(await screen.findByText('Premium purchase')).toBeInTheDocument()
    expect(screen.getByRole('button', {
      name: 'Product resume is protected by a premium purchase',
    })).toBeDisabled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('shows the server guard error when protection changes after the list read', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        resumes: [{ ...resume, protectedByPurchase: false }],
        count: 1,
        limit: 2,
        hasProfile: true,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error:
          'This resume has an active premium purchase and cannot be deleted.',
        code: 'PREMIUM_RESUME_PURCHASE_ACTIVE',
      }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('confirm', vi.fn(() => true))

    render(<ResumeDashboardPage />)
    fireEvent.click(await screen.findByRole('button', {
      name: 'Delete Product resume',
    }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
      'This resume has an active premium purchase and cannot be deleted.',
    ))
  })
})
