import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.ComponentProps<'a'>) => (
    <a href={String(href)} {...props}>{children}</a>
  ),
}))

import HireSignInPage from '../page'

const WORKSPACE_ID = 'a'.repeat(24)
const SETUP_CREDENTIAL = `${WORKSPACE_ID}.${'b'.repeat(64)}`

beforeEach(() => {
  window.localStorage.clear()
  window.history.replaceState({}, '', '/hire-signin')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HireSignInPage', () => {
  it('asks for a readable company workspace for ordinary password sign-in', async () => {
    render(<HireSignInPage />)

    expect(await screen.findByLabelText('Company workspace')).toHaveAttribute(
      'pattern',
      '[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*',
    )
    expect(screen.getByLabelText('Company workspace')).toHaveAttribute(
      'placeholder',
      'acme',
    )
    expect(screen.getByLabelText('Work email')).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toHaveAttribute(
      'autocomplete',
      'current-password',
    )
    fireEvent.change(screen.getByLabelText('Company workspace'), {
      target: { value: ' Acme ' },
    })
    fireEvent.blur(screen.getByLabelText('Company workspace'))
    expect(screen.getByLabelText('Company workspace')).toHaveValue('acme')
  })

  it('reads setup credential from the fragment and immediately scrubs the secret', async () => {
    window.history.replaceState({}, '', `/hire-signin#setup=${SETUP_CREDENTIAL}`)

    render(<HireSignInPage />)

    expect(await screen.findByRole('button', { name: 'Set password and sign in' }))
      .toBeInTheDocument()
    expect(screen.queryByLabelText('Work email')).not.toBeInTheDocument()
    expect(screen.queryByText(WORKSPACE_ID)).not.toBeInTheDocument()
    expect(screen.getByLabelText('Confirm password')).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe(''))
    expect(window.localStorage.getItem('ipg-hire-workspace-id')).toBeNull()
    expect(window.localStorage.getItem('ipg-hire-workspace-handle')).toBeNull()
  })

  it('reads and migrates a remembered legacy coordinate without exposing it as an ID field', async () => {
    window.localStorage.setItem('ipg-hire-workspace-id', WORKSPACE_ID)

    render(<HireSignInPage />)

    expect(await screen.findByLabelText('Company workspace')).toHaveValue(WORKSPACE_ID)
    expect(screen.queryByText('Workspace sign-in ID')).not.toBeInTheDocument()
  })

  it('retains the setup coordinate only when a pre-backfill response has no slug', async () => {
    window.history.replaceState({}, '', `/hire-signin#setup=${SETUP_CREDENTIAL}`)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      workspace: { slug: null },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    render(<HireSignInPage />)
    fireEvent.change(await screen.findByLabelText('Password'), {
      target: { value: 'StrongPassword1' },
    })
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'StrongPassword1' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Set password and sign in' }))

    await waitFor(() => {
      expect(window.localStorage.getItem('ipg-hire-workspace-handle')).toBe(
        WORKSPACE_ID,
      )
    })
    expect(screen.queryByText(WORKSPACE_ID)).not.toBeInTheDocument()
  })

  it('rejects a malformed setup fragment without retaining it in browser history', async () => {
    window.history.replaceState({}, '', '/hire-signin#setup=raw-secret-without-workspace')

    render(<HireSignInPage />)

    expect(await screen.findByRole('alert')).toHaveTextContent('invalid or incomplete')
    expect(window.location.hash).toBe('')
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })
})
