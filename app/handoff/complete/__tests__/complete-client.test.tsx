import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { STORAGE_KEYS } from '@shared/storageKeys'

const mocks = vi.hoisted(() => ({ signOut: vi.fn() }))

vi.mock('next-auth/react', () => ({ signOut: mocks.signOut }))

import HireRuntimeCompleteClient from '../complete-client'

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  sessionStorage.clear()
  mocks.signOut.mockResolvedValue(undefined)
})

afterEach(cleanup)

describe('isolated runtime completion page', () => {
  it('ends the runtime session without redirecting and shows a neutral close-tab state', async () => {
    localStorage.setItem(STORAGE_KEYS.INTERVIEW_DATA, 'candidate transcript')
    localStorage.setItem(STORAGE_KEYS.INTERVIEW_CONFIG, 'candidate config')
    sessionStorage.setItem('feedback-session:runtime', 'candidate feedback')
    render(
      <HireRuntimeCompleteClient controlUrl="https://hire.interviewprep.guru" />,
    )

    expect(
      screen.getByRole('heading', { name: 'Interview submitted' }),
    ).toBeTruthy()
    expect(screen.getByText(/You can safely close this tab\./)).toBeTruthy()
    expect(
      screen.getByRole('link', { name: 'Return to InterviewPrep Guru Hire' }),
    ).toHaveAttribute('href', 'https://hire.interviewprep.guru')
    await waitFor(() => {
      expect(mocks.signOut).toHaveBeenCalledOnce()
      expect(mocks.signOut).toHaveBeenCalledWith({ redirect: false })
      expect(localStorage.getItem(STORAGE_KEYS.INTERVIEW_DATA)).toBeNull()
      expect(localStorage.getItem(STORAGE_KEYS.INTERVIEW_CONFIG)).toBeNull()
      expect(sessionStorage.getItem('feedback-session:runtime')).toBeNull()
    })
  })
})
