import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

describe('HireSignInPage', () => {
  it('requires a workspace coordinate for ordinary password sign-in', async () => {
    render(<HireSignInPage />)

    expect(await screen.findByLabelText(/Workspace sign-in ID/)).toHaveAttribute(
      'pattern',
      '[A-Fa-f0-9]{24}',
    )
    expect(screen.getByLabelText('Work email')).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toHaveAttribute(
      'autocomplete',
      'current-password',
    )
  })

  it('reads setup credential from the fragment and immediately scrubs the secret', async () => {
    window.history.replaceState({}, '', `/hire-signin#setup=${SETUP_CREDENTIAL}`)

    render(<HireSignInPage />)

    expect(await screen.findByRole('button', { name: 'Set password and sign in' }))
      .toBeInTheDocument()
    expect(screen.queryByLabelText('Work email')).not.toBeInTheDocument()
    expect(screen.getByText(WORKSPACE_ID)).toBeInTheDocument()
    expect(screen.getByLabelText('Confirm password')).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe(''))
    expect(window.localStorage.getItem('ipg-hire-workspace-id')).toBe(WORKSPACE_ID)
  })

  it('rejects a malformed setup fragment without retaining it in browser history', async () => {
    window.history.replaceState({}, '', '/hire-signin#setup=raw-secret-without-workspace')

    render(<HireSignInPage />)

    expect(await screen.findByRole('alert')).toHaveTextContent('invalid or incomplete')
    expect(window.location.hash).toBe('')
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })
})
