import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import SignInForm from '@shared/ui/SignInForm'
import { JOBS_STORAGE_KEYS, STORAGE_KEYS } from '@shared/storageKeys'

const auth = vi.hoisted(() => ({
  signIn: vi.fn(),
  signOut: vi.fn(),
  useSession: vi.fn(),
}))

vi.mock('next-auth/react', () => auth)

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  auth.signIn.mockReset().mockResolvedValue(undefined)
  auth.signOut.mockReset().mockResolvedValue(undefined)
  auth.useSession.mockReset().mockReturnValue({ data: null })
  window.history.replaceState({}, '', '/')
})

afterEach(cleanup)

describe('SignInForm OAuth cleanup', () => {
  it('keeps the Tailor continuation but removes other account state before sign-in', async () => {
    const jobId = '507f1f77bcf86cd799439011'
    localStorage.setItem(STORAGE_KEYS.INTERVIEW_DATA, 'private interview state')
    localStorage.setItem('jobs:private-state', 'private jobs state')
    sessionStorage.setItem('JOBS_TARGET', 'resume-derived target')
    sessionStorage.setItem(JOBS_STORAGE_KEYS.TAILOR_PENDING_ASSOCIATION, 'short-lived Tailor handoff')

    render(<SignInForm callbackUrl={`/resume/tailor?jobId=${jobId}`} />)
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }))

    await waitFor(() => {
      expect(auth.signIn).toHaveBeenCalledWith('google', {
        callbackUrl: `/resume/tailor?jobId=${jobId}`,
      })
    })
    expect(auth.signOut).toHaveBeenCalledWith({ redirect: false })
    expect(localStorage.getItem(STORAGE_KEYS.INTERVIEW_DATA)).toBeNull()
    expect(localStorage.getItem('jobs:private-state')).toBeNull()
    expect(sessionStorage.getItem('JOBS_TARGET')).toBeNull()
    expect(sessionStorage.getItem(JOBS_STORAGE_KEYS.TAILOR_PENDING_ASSOCIATION)).toBe('short-lived Tailor handoff')
  })

  it('removes the Tailor continuation for a generic sign-in target', async () => {
    sessionStorage.setItem(JOBS_STORAGE_KEYS.TAILOR_PENDING_ASSOCIATION, 'stale Tailor handoff')

    render(<SignInForm callbackUrl="/jobs" />)
    fireEvent.click(screen.getByRole('button', { name: 'Continue with GitHub' }))

    await waitFor(() => expect(auth.signIn).toHaveBeenCalledWith('github', { callbackUrl: '/jobs' }))
    expect(sessionStorage.getItem(JOBS_STORAGE_KEYS.TAILOR_PENDING_ASSOCIATION)).toBeNull()
  })

  it('does not preserve Tailor state for a cross-origin callback', async () => {
    sessionStorage.setItem(JOBS_STORAGE_KEYS.TAILOR_PENDING_ASSOCIATION, 'stale Tailor handoff')

    render(<SignInForm callbackUrl="https://example.net/resume/tailor?jobId=507f1f77bcf86cd799439011" />)
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }))

    await waitFor(() => expect(auth.signIn).toHaveBeenCalled())
    expect(sessionStorage.getItem(JOBS_STORAGE_KEYS.TAILOR_PENDING_ASSOCIATION)).toBeNull()
  })

  it('preserves the Tailor continuation when the current page is the callback target', async () => {
    const path = '/resume/tailor?jobId=507f1f77bcf86cd799439011'
    window.history.replaceState({}, '', path)
    sessionStorage.setItem(JOBS_STORAGE_KEYS.TAILOR_PENDING_ASSOCIATION, 'short-lived Tailor handoff')

    render(<SignInForm />)
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }))

    await waitFor(() => expect(auth.signIn).toHaveBeenCalledWith('google', {
      callbackUrl: window.location.href,
    }))
    expect(sessionStorage.getItem(JOBS_STORAGE_KEYS.TAILOR_PENDING_ASSOCIATION)).toBe('short-lived Tailor handoff')
  })
})
