import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AuthGateProvider, useAuthGate } from '@shared/providers/AuthGateProvider'
import SignedOutEmptyState from '@shared/ui/SignedOutEmptyState'

// ── next-auth/react mock — controllable status ───────────────────────────
let mockStatus: 'loading' | 'unauthenticated' | 'authenticated' = 'unauthenticated'
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: mockStatus }),
  signIn: vi.fn(),
  signOut: vi.fn(),
}))

// next/link is fine in JSDOM but mock to be safe
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    <a href={href}>{children}</a>,
}))

function TestButton({ onAuthed }: { onAuthed: () => void }) {
  const { requireAuth } = useAuthGate()
  return (
    <button onClick={() => requireAuth('save_resume', onAuthed)}>Trigger</button>
  )
}

describe('AuthGateProvider', () => {
  beforeEach(() => { mockStatus = 'unauthenticated' })

  it('opens the modal for an anonymous user and does not run the callback', () => {
    const cb = vi.fn()
    render(
      <AuthGateProvider>
        <TestButton onAuthed={cb} />
      </AuthGateProvider>
    )
    fireEvent.click(screen.getByText('Trigger'))
    expect(cb).not.toHaveBeenCalled()
    // Modal title for save_resume reason
    expect(screen.getByText('Sign in to save your resume')).toBeTruthy()
  })

  it('runs the callback immediately when the user is authenticated', () => {
    mockStatus = 'authenticated'
    const cb = vi.fn()
    render(
      <AuthGateProvider>
        <TestButton onAuthed={cb} />
      </AuthGateProvider>
    )
    fireEvent.click(screen.getByText('Trigger'))
    expect(cb).toHaveBeenCalledTimes(1)
    // Modal should NOT have rendered
    expect(screen.queryByText('Sign in to save your resume')).toBeNull()
  })

  it('closes the modal on Escape', () => {
    render(
      <AuthGateProvider>
        <TestButton onAuthed={() => {}} />
      </AuthGateProvider>
    )
    fireEvent.click(screen.getByText('Trigger'))
    expect(screen.getByText('Sign in to save your resume')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByText('Sign in to save your resume')).toBeNull()
  })
})

describe('SignedOutEmptyState', () => {
  beforeEach(() => { mockStatus = 'unauthenticated' })

  it('renders headline and opens the modal when Sign in is clicked', () => {
    render(
      <AuthGateProvider>
        <SignedOutEmptyState
          reason="view_history"
          headline="See your past interviews here"
        />
      </AuthGateProvider>
    )
    expect(screen.getByText('See your past interviews here')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(screen.getByText('Sign in to see your interview history')).toBeTruthy()
  })
})
