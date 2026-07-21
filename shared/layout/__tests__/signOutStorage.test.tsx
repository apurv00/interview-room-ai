import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import AppShell from '@shared/layout/AppShell'
import HireLayout from '../../../app/(hire)/hire/layout'
import ResumeLayout from '../../../app/(resume)/resume/layout'
import { JOBS_STORAGE_KEYS, STORAGE_KEYS } from '@shared/storageKeys'

const auth = vi.hoisted(() => ({
  signOut: vi.fn(),
  useSession: vi.fn(),
}))

vi.mock('next-auth/react', () => auth)
vi.mock('next/navigation', () => ({
  usePathname: () => '/jobs',
}))
vi.mock('@shared/providers/AuthGateProvider', () => ({
  useAuthGate: () => ({ open: vi.fn() }),
}))
vi.mock('@shared/layout/AuthMenu', () => ({ default: () => null }))
vi.mock('@shared/layout/Footer', () => ({ default: () => null }))

function seedPrivateBrowserState() {
  localStorage.setItem(STORAGE_KEYS.INTERVIEW_CONFIG, 'private config')
  localStorage.setItem('jobs:private-state', 'private jobs state')
  localStorage.setItem('resume:draft:user-1:new', 'private authenticated resume draft')
  localStorage.setItem('resume:draft:anon', 'anonymous builder draft')
  localStorage.setItem('wizardDraft:user-1', 'private wizard draft')
  localStorage.setItem('ipg_distinct_id', 'user-1')
  sessionStorage.setItem('JOBS_TARGET', 'private resume target')
  sessionStorage.setItem(JOBS_STORAGE_KEYS.TAILOR_PENDING_ASSOCIATION, 'private Tailor continuation')
  sessionStorage.setItem('feedback-session:session-1', 'private feedback snapshot')
  sessionStorage.setItem('recording-url:v2:camera:session-1', 'private presigned URL')
}

function expectPrivateBrowserStateCleared() {
  expect(localStorage.getItem(STORAGE_KEYS.INTERVIEW_CONFIG)).toBeNull()
  expect(localStorage.getItem('jobs:private-state')).toBeNull()
  expect(localStorage.getItem('resume:draft:user-1:new')).toBeNull()
  expect(localStorage.getItem('wizardDraft:user-1')).toBeNull()
  expect(localStorage.getItem('ipg_distinct_id')).toBeNull()
  expect(localStorage.getItem('resume:draft:anon')).toBe('anonymous builder draft')
  expect(sessionStorage.getItem('JOBS_TARGET')).toBeNull()
  expect(sessionStorage.getItem(JOBS_STORAGE_KEYS.TAILOR_PENDING_ASSOCIATION)).toBeNull()
  expect(sessionStorage.getItem('feedback-session:session-1')).toBeNull()
  expect(sessionStorage.getItem('recording-url:v2:camera:session-1')).toBeNull()
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  auth.useSession.mockReset().mockReturnValue({
    data: { user: { name: 'Candidate', email: 'candidate@example.com' } },
    status: 'authenticated',
  })
  auth.signOut.mockReset().mockImplementation(() => {
    expectPrivateBrowserStateCleared()
    return Promise.resolve()
  })
})

afterEach(cleanup)

describe('direct sign-out surfaces', () => {
  it('scrubs account-bound state before AppShell signs out', async () => {
    seedPrivateBrowserState()
    render(<AppShell><p>Page</p></AppShell>)

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign Out' }))

    await waitFor(() => expect(auth.signOut).toHaveBeenCalledWith({ callbackUrl: '/' }))
    expectPrivateBrowserStateCleared()
  })

  it('scrubs account-bound state before Hire signs out', async () => {
    seedPrivateBrowserState()
    render(<HireLayout><p>Hire page</p></HireLayout>)

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    await waitFor(() => expect(auth.signOut).toHaveBeenCalledWith({ callbackUrl: '/' }))
    expectPrivateBrowserStateCleared()
  })

  it('scrubs account-bound state before Resume signs out', async () => {
    seedPrivateBrowserState()
    render(<ResumeLayout><p>Resume page</p></ResumeLayout>)

    fireEvent.click(screen.getByRole('button', { name: 'Sign Out' }))

    await waitFor(() => expect(auth.signOut).toHaveBeenCalledWith({ callbackUrl: '/' }))
    expectPrivateBrowserStateCleared()
  })
})
