import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { STORAGE_KEYS } from '@shared/storageKeys'

const mocks = vi.hoisted(() => ({
  signOut: vi.fn(),
  settleRequiredReplay: vi.fn(),
}))

vi.mock('next-auth/react', () => ({ signOut: mocks.signOut }))
vi.mock('@interview/utils/resumableUpload', () => ({
  settleRequiredHireReplayUploads: mocks.settleRequiredReplay,
}))

import HireRuntimeCompleteClient from '../complete-client'

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  sessionStorage.clear()
  mocks.signOut.mockResolvedValue(undefined)
  mocks.settleRequiredReplay.mockResolvedValue({
    uploadedKinds: [],
    pendingKinds: [],
    acknowledgedUnavailableKinds: [],
  })
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

  it('does not purge or sign out while a required multipart finalization is held', async () => {
    localStorage.setItem(STORAGE_KEYS.INTERVIEW_DATA, 'candidate transcript')
    let releaseSettlement: (() => void) | undefined
    mocks.settleRequiredReplay.mockImplementationOnce(
      () => new Promise((resolve) => {
        releaseSettlement = () => resolve({
          uploadedKinds: [],
          pendingKinds: ['camera'],
          acknowledgedUnavailableKinds: [],
        })
      }),
    )
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          state: 'pending',
          reason: 'media',
          sessionId: '1'.repeat(24),
          media: { camera: 'pending', screen: 'not_required' },
        }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          state: 'pending',
          reason: 'media',
          sessionId: '1'.repeat(24),
          media: { camera: 'pending', screen: 'not_required' },
        }),
      } as unknown as Response)

    render(
      <HireRuntimeCompleteClient controlUrl="https://hire.interviewprep.guru" />,
    )

    await waitFor(() => expect(mocks.settleRequiredReplay).toHaveBeenCalledOnce())
    expect(mocks.signOut).not.toHaveBeenCalled()
    expect(localStorage.getItem(STORAGE_KEYS.INTERVIEW_DATA)).toBe(
      'candidate transcript',
    )

    releaseSettlement?.()
    expect(
      await screen.findByRole('heading', { name: 'Submission not confirmed' }),
    ).toBeTruthy()
    expect(mocks.signOut).not.toHaveBeenCalled()
    expect(localStorage.getItem(STORAGE_KEYS.INTERVIEW_DATA)).toBe(
      'candidate transcript',
    )
  })

  it('signs out only after a terminal unavailable media state is durable', async () => {
    localStorage.setItem(STORAGE_KEYS.INTERVIEW_DATA, 'candidate transcript')
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          state: 'pending',
          reason: 'media',
          sessionId: '1'.repeat(24),
          media: { camera: 'pending', screen: 'pending' },
        }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          state: 'completed',
          degraded: true,
          sessionId: '1'.repeat(24),
          media: { camera: 'unavailable', screen: 'published' },
        }),
      } as unknown as Response)

    render(
      <HireRuntimeCompleteClient controlUrl="https://hire.interviewprep.guru" />,
    )

    expect(
      await screen.findByRole('heading', {
        name: 'Interview submitted with a recording issue',
      }),
    ).toBeTruthy()
    expect(mocks.settleRequiredReplay).toHaveBeenCalledWith({
      sessionId: '1'.repeat(24),
      kinds: ['camera', 'screen'],
      timeoutMs: 8_000,
    })
    expect(mocks.signOut).toHaveBeenCalledWith({ redirect: false })
    expect(localStorage.getItem(STORAGE_KEYS.INTERVIEW_DATA)).toBeNull()
  })

  it.each(['revoked', 'purging'] as const)(
    'clears IndexedDB-backed interview state and signs out when access is %s',
    async (reason) => {
      localStorage.setItem(STORAGE_KEYS.INTERVIEW_DATA, 'candidate transcript')
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 410,
        json: vi.fn().mockResolvedValue({
          state: 'account_unavailable',
          reason,
          code: 'ACCOUNT_UNAVAILABLE',
        }),
      } as unknown as Response)

      render(
        <HireRuntimeCompleteClient controlUrl="https://hire.interviewprep.guru" />,
      )

      expect(
        await screen.findByRole('heading', { name: 'Interview access ended' }),
      ).toBeTruthy()
      expect(mocks.settleRequiredReplay).not.toHaveBeenCalled()
      expect(mocks.signOut).toHaveBeenCalledWith({ redirect: false })
      expect(localStorage.getItem(STORAGE_KEYS.INTERVIEW_DATA)).toBeNull()
    },
  )

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
