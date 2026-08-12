import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { STORAGE_KEYS } from '@shared/storageKeys'

const mocks = vi.hoisted(() => ({ signOut: vi.fn() }))

vi.mock('next-auth/react', () => ({ signOut: mocks.signOut }))

import HireRuntimeCompleteClient from '../complete-client'

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  sessionStorage.clear()
  mocks.signOut.mockResolvedValue(undefined)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue({ state: 'completed' }),
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('isolated runtime completion page', () => {
  it('ends the runtime session without redirecting and shows a neutral close-tab state', async () => {
    localStorage.setItem(STORAGE_KEYS.INTERVIEW_DATA, 'candidate transcript')
    localStorage.setItem(STORAGE_KEYS.INTERVIEW_CONFIG, 'candidate config')
    sessionStorage.setItem('feedback-session:runtime', 'candidate feedback')
    render(
      <HireRuntimeCompleteClient controlUrl="https://hire.interviewprep.guru" />,
    )

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Interview submitted' }),
      ).toBeTruthy()
      expect(mocks.signOut).toHaveBeenCalledOnce()
      expect(mocks.signOut).toHaveBeenCalledWith({ redirect: false })
      expect(localStorage.getItem(STORAGE_KEYS.INTERVIEW_DATA)).toBeNull()
      expect(localStorage.getItem(STORAGE_KEYS.INTERVIEW_CONFIG)).toBeNull()
      expect(sessionStorage.getItem('feedback-session:runtime')).toBeNull()
    })
    expect(screen.getByText(/You can safely close this tab\./)).toBeTruthy()
    expect(
      screen.getByRole('link', { name: 'Return to InterviewPrep Guru Hire' }),
    ).toHaveAttribute('href', 'https://hire.interviewprep.guru')
  })

  it('keeps local interview data and the runtime session until durable completion is confirmed', async () => {
    localStorage.setItem(STORAGE_KEYS.INTERVIEW_DATA, 'candidate transcript')
    localStorage.setItem(STORAGE_KEYS.INTERVIEW_CONFIG, 'candidate config')
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ state: 'pending' }),
    } as unknown as Response)
    render(
      <HireRuntimeCompleteClient controlUrl="https://hire.interviewprep.guru" />,
    )

    expect(
      await screen.findByRole('heading', { name: 'Submission not confirmed' }),
    ).toBeTruthy()
    expect(mocks.signOut).not.toHaveBeenCalled()
    expect(localStorage.getItem(STORAGE_KEYS.INTERVIEW_DATA)).toBe('candidate transcript')
    expect(localStorage.getItem(STORAGE_KEYS.INTERVIEW_CONFIG)).toBe('candidate config')

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ state: 'completed' }),
    } as unknown as Response)
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Interview submitted' })).toBeTruthy()
      expect(mocks.signOut).toHaveBeenCalledOnce()
      expect(localStorage.getItem(STORAGE_KEYS.INTERVIEW_DATA)).toBeNull()
      expect(localStorage.getItem(STORAGE_KEYS.INTERVIEW_CONFIG)).toBeNull()
    })
  })

  it('does not claim a safe close when host-only sign-out fails', async () => {
    localStorage.setItem(STORAGE_KEYS.INTERVIEW_DATA, 'candidate transcript')
    mocks.signOut
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce(undefined)
    render(
      <HireRuntimeCompleteClient controlUrl="https://hire.interviewprep.guru" />,
    )

    expect(
      await screen.findByRole('heading', {
        name: 'Interview saved — secure cleanup pending',
      }),
    ).toBeTruthy()
    expect(screen.queryByText(/You can safely close this tab\./)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Finish secure cleanup' }))
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Interview submitted' })).toBeTruthy()
      expect(mocks.signOut).toHaveBeenCalledTimes(2)
    })
  })
})
