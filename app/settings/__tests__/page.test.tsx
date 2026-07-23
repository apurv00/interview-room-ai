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
const DEFAULT_JOBS_EMAIL_ENABLED = { e0: true, e1: true, e2: true, e4: true }
const QUIET_HOURS = {
  label: '08:00 until 21:00 IST',
  timezone: 'Asia/Kolkata',
}
const jobsEmailPayload = () => ({
  enabled: { ...DEFAULT_JOBS_EMAIL_ENABLED },
  quietHours: QUIET_HOURS,
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.signOut.mockResolvedValue(undefined)
  mocks.clearAllInterviewStorage.mockResolvedValue(undefined)
  mocks.fetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/account') return jsonResponse({ ok: true })
    if (url === '/api/settings/jobs-email') {
      if (init?.method === 'PATCH') {
        const patch = JSON.parse(String(init.body)) as {
          enabled: Partial<typeof DEFAULT_JOBS_EMAIL_ENABLED>
        }
        return jsonResponse({
          enabled: { ...DEFAULT_JOBS_EMAIL_ENABLED, ...patch.enabled },
          quietHours: QUIET_HOURS,
        })
      }
      return jsonResponse(jobsEmailPayload())
    }
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
      if (url === '/api/settings/jobs-email') return jsonResponse(jobsEmailPayload())
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
      if (url === '/api/settings/jobs-email') return jsonResponse(jobsEmailPayload())
      return jsonResponse({})
    })

    confirmDeletion()

    await waitFor(() => expect(mocks.clearAllInterviewStorage).toHaveBeenCalledTimes(1))
    expect(mocks.signOut).toHaveBeenCalledWith({ redirect: false })
    expect(mocks.clearAllInterviewStorage.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.signOut.mock.invocationCallOrder[0])
  })
})

describe('Settings job email preferences', () => {
  it('labels each stream and the fixed IST delivery window accurately', async () => {
    render(<SettingsPage />)

    expect(await screen.findByRole('checkbox', {
      name: 'Requested practice links',
    })).toBeChecked()
    const checkIn = screen.getByRole('checkbox', { name: '14-day application check-ins' })
    expect(checkIn).toBeChecked()
    expect(checkIn).toHaveAttribute(
      'aria-describedby',
      'jobs-email-e1-description',
    )
    expect(screen.getByText(/14 days after you mark an application as applied/i)).toHaveAttribute(
      'id',
      'jobs-email-e1-description',
    )
    expect(screen.getByRole('checkbox', { name: 'Exact interview reminders' })).toBeChecked()
    expect(screen.getByRole('checkbox', {
      name: 'Deferred-practice reminders',
    })).toBeChecked()
    expect(screen.getByText('Send window: 08:00 until 21:00 IST')).toBeInTheDocument()
    expect(screen.getByText(/Send attempts use Asia\/Kolkata/i)).toBeInTheDocument()
  })

  it('sends only the changed stream and confirms the merged server state', async () => {
    render(<SettingsPage />)
    const responseNudges = await screen.findByRole('checkbox', {
      name: '14-day application check-ins',
    })

    fireEvent.click(responseNudges)
    fireEvent.click(screen.getByRole('button', { name: 'Save job email preferences' }))

    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledWith(
      '/api/settings/jobs-email',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          enabled: { e1: false },
        }),
      }),
    ))
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Job email preferences saved.',
    )
  })

  it('offers explicit global opt-out and resubscribe actions', async () => {
    render(<SettingsPage />)
    await screen.findByRole('checkbox', { name: 'Requested practice links' })

    fireEvent.click(screen.getByRole('button', { name: 'Turn off all job emails' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save job email preferences' }))

    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledWith(
      '/api/settings/jobs-email',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          enabled: { e0: false, e1: false, e2: false, e4: false },
        }),
      }),
    ))
    await screen.findByRole('status')

    fireEvent.click(screen.getByRole('button', { name: 'Turn on all job emails' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save job email preferences' }))

    await waitFor(() => {
      const patchCalls = mocks.fetch.mock.calls.filter(([, init]) =>
        (init as RequestInit | undefined)?.method === 'PATCH')
      expect(patchCalls).toHaveLength(2)
      expect(JSON.parse(String((patchCalls[1][1] as RequestInit).body))).toEqual({
        enabled: { e0: true, e1: true, e2: true, e4: true },
      })
    })
  })

  it('shows a clear save error without replacing the selected values', async () => {
    mocks.fetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/settings/jobs-email' && init?.method === 'PATCH') {
        return jsonResponse({
          error: 'account unavailable',
          code: 'ACCOUNT_UNAVAILABLE',
        }, false, 401)
      }
      if (url === '/api/settings/jobs-email') {
        return jsonResponse(jobsEmailPayload())
      }
      return jsonResponse({})
    })
    render(<SettingsPage />)
    const deferred = await screen.findByRole('checkbox', {
      name: 'Deferred-practice reminders',
    })

    fireEvent.click(deferred)
    fireEvent.click(screen.getByRole('button', { name: 'Save job email preferences' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Job email preferences are unavailable for this account.',
    )
    expect(deferred).not.toBeChecked()
  })

  it('retries a failed preference load without reloading the page', async () => {
    let jobsReads = 0
    mocks.fetch.mockImplementation((input: RequestInfo | URL) => {
      if (String(input) !== '/api/settings/jobs-email') return jsonResponse({})
      jobsReads += 1
      if (jobsReads === 1) return jsonResponse({ error: 'temporary' }, false)
      return jsonResponse(jobsEmailPayload())
    })

    render(<SettingsPage />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load job email preferences. Please try again.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByRole('checkbox', {
      name: 'Requested practice links',
    })).toBeChecked()
    expect(jobsReads).toBe(2)
  })
})
