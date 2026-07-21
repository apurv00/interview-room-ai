import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  push: vi.fn(),
  signOut: vi.fn(),
  clearAllInterviewStorage: vi.fn(),
}))

vi.stubGlobal('fetch', mocks.fetch)
vi.mock('next-auth/react', () => ({
  useSession: () => ({
    status: 'authenticated',
    data: { user: { id: 'user-1', name: 'Test User', email: 'user@example.com', plan: 'free' } },
  }),
  signOut: mocks.signOut,
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('next/image', () => ({ default: () => <span data-testid="image" /> }))
vi.mock('@shared/storageKeys', () => ({ clearAllInterviewStorage: mocks.clearAllInterviewStorage }))

import SettingsPage from '../page'

const jsonResponse = (value: unknown, ok = true, status = ok ? 200 : 503) =>
  Promise.resolve({ ok, status, json: () => Promise.resolve(value) })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.signOut.mockResolvedValue(undefined)
  mocks.clearAllInterviewStorage.mockResolvedValue(undefined)
  mocks.fetch.mockImplementation((input: RequestInfo | URL) => {
    const url = String(input)
    if (url === '/api/account') return jsonResponse({ ok: true })
    return jsonResponse({})
  })
})

function confirmDeletion() {
  render(<SettingsPage />)
  fireEvent.click(screen.getByRole('button', { name: 'Delete account' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Confirm email' }), {
    target: { value: 'user@example.com' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Delete forever' }))
}

describe('Settings account deletion cleanup', () => {
  it('awaits replay/storage purge before signing out after server deletion succeeds', async () => {
    let finishCleanup: (() => void) | undefined
    mocks.clearAllInterviewStorage.mockReturnValue(new Promise<void>((resolve) => {
      finishCleanup = resolve
    }))
    confirmDeletion()

    await waitFor(() => expect(mocks.clearAllInterviewStorage).toHaveBeenCalledTimes(1))
    expect(mocks.signOut).not.toHaveBeenCalled()

    finishCleanup?.()
    await waitFor(() => expect(mocks.signOut).toHaveBeenCalledWith({ redirect: false }))
    expect(mocks.signOut).toHaveBeenCalledWith({ redirect: false })
    expect(mocks.clearAllInterviewStorage.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.signOut.mock.invocationCallOrder[0])
  })

  it('preserves local state when deletion is incomplete so the user can retry', async () => {
    mocks.fetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/account') {
        return jsonResponse({
          error: 'We started deleting your account but could not finish. Please try again or contact support.',
          code: 'ACCOUNT_DELETION_INCOMPLETE',
        }, false, 503)
      }
      return jsonResponse({})
    })

    confirmDeletion()

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not finish/i)
    expect(mocks.clearAllInterviewStorage).not.toHaveBeenCalled()
    expect(mocks.signOut).not.toHaveBeenCalled()
  })

  it('finishes local cleanup when a retry reports the account was already deleted', async () => {
    mocks.fetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/account') {
        return jsonResponse({
          ok: true,
          alreadyDeleted: true,
          code: 'ACCOUNT_ALREADY_DELETED',
        })
      }
      return jsonResponse({})
    })

    confirmDeletion()

    await waitFor(() => expect(mocks.clearAllInterviewStorage).toHaveBeenCalledTimes(1))
    expect(mocks.signOut).toHaveBeenCalledWith({ redirect: false })
    expect(mocks.clearAllInterviewStorage.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.signOut.mock.invocationCallOrder[0])
  })
})
