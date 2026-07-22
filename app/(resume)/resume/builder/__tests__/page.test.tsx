import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'

const { mockSaveResult, searchState, sessionState } = vi.hoisted(() => ({
  mockSaveResult: vi.fn(),
  searchState: { params: new URLSearchParams() },
  sessionState: {
    value: { status: 'unauthenticated' as 'loading' | 'unauthenticated' | 'authenticated', data: null as null | { user: { id: string } } },
  },
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => searchState.params,
}))
vi.mock('next-auth/react', () => ({
  useSession: () => sessionState.value,
}))
vi.mock('@shared/providers/AuthGateProvider', () => ({
  useAuthGate: () => ({ requireAuth: vi.fn() }),
}))
vi.mock('@resume/components/ResumeEditor', () => ({
  default: function MockResumeEditor({ initialData, onSave, resumeId }: {
    initialData?: { name?: string }
    onSave: (data: { name: string }) => Promise<unknown>
    resumeId?: string
  }) {
    // ResumeEditor/useResume intentionally treats initialData as an initializer.
    // This stateful mock catches identity changes that fail to remount it.
    const [localName, setLocalName] = useState(initialData?.name ?? 'new')
    return (
      <div>
        <div>Resume editor</div>
        <div>Loaded resume: {localName} ({resumeId ?? 'unsaved'})</div>
        <button type="button" onClick={() => setLocalName('User A private edits')}>Type private edits</button>
        <button type="button" onClick={() => void onSave({ name: 'Jobs Resume' }).then(mockSaveResult)}>
          Save mocked resume
        </button>
      </div>
    )
  },
}))

import ResumeBuilderPage from '../page'

const JOB_ID = '507f1f77bcf86cd799439011'

beforeEach(() => {
  searchState.params = new URLSearchParams()
  sessionState.value = { status: 'unauthenticated', data: null }
  localStorage.clear()
  mockSaveResult.mockReset()
  vi.unstubAllGlobals()
})

describe('Resume Builder tracked-job return', () => {
  it('renders an exact same-job return action for a validated jobId', async () => {
    searchState.params = new URLSearchParams(`jobId=${JOB_ID}`)

    render(<ResumeBuilderPage />)

    expect(await screen.findByText('Resume editor')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Return to job application' })).toHaveAttribute(
      'href',
      `/jobs/${JOB_ID}?from=tailor#apply`,
    )
  })

  it('does not turn an arbitrary return value into a navigation target', async () => {
    searchState.params = new URLSearchParams('jobId=https://evil.example/steal')

    render(<ResumeBuilderPage />)

    expect(await screen.findByText('Resume editor')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Return to job application' })).toBeNull()
  })

  it('preserves the exact Jobs onboarding return before save without auto-navigation', async () => {
    searchState.params = new URLSearchParams({ return: '/jobs/start' })

    render(<ResumeBuilderPage />)

    expect(await screen.findByText('Resume editor')).toBeTruthy()
    expect(screen.getByText(/You came from Jobs/i)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Back to job setup' })).toHaveAttribute('href', '/jobs/start')
    expect(screen.queryByRole('link', { name: 'Continue to job setup' })).toBeNull()
  })

  it.each([
    'https://evil.example/steal',
    '//evil.example/steal',
    '/jobs/start?next=https://evil.example',
    '/jobs/start/../admin',
    '/jobs',
  ])('rejects non-allowlisted return intent %s', async (unsafeReturn) => {
    searchState.params = new URLSearchParams({ return: unsafeReturn })

    render(<ResumeBuilderPage />)

    expect(await screen.findByText('Resume editor')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Back to job setup' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Continue to job setup' })).toBeNull()
  })

  it('gives a validated tracked job precedence over the generic Jobs return', async () => {
    searchState.params = new URLSearchParams({ jobId: JOB_ID, return: '/jobs/start' })

    render(<ResumeBuilderPage />)

    expect(await screen.findByText('Resume editor')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Return to job application' })).toHaveAttribute(
      'href',
      `/jobs/${JOB_ID}?from=tailor#apply`,
    )
    expect(screen.queryByRole('link', { name: 'Back to job setup' })).toBeNull()
  })

  it('offers a user-directed Jobs continuation only after a successful save', async () => {
    searchState.params = new URLSearchParams({ return: '/jobs/start' })
    sessionState.value = { status: 'authenticated', data: { user: { id: 'user-1' } } }
    const mockFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/resume/save' && init?.method === 'POST') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'resume-1' }) })
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ resumes: [], count: 0, limit: 3 }),
      })
    })
    vi.stubGlobal('fetch', mockFetch)

    render(<ResumeBuilderPage />)
    await screen.findByText('Resume editor')
    fireEvent.click(screen.getByRole('button', { name: 'Save mocked resume' }))

    expect(await screen.findByText(/A saved version is ready in My Resumes/i)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Continue to job setup' })).toHaveAttribute('href', '/jobs/start')
    expect(screen.queryByRole('link', { name: 'Back to job setup' })).toBeNull()
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(
      '/api/resume/save',
      expect.objectContaining({ method: 'POST' }),
    ))
  })

  it('keeps the pre-save return state when persistence fails', async () => {
    searchState.params = new URLSearchParams({ return: '/jobs/start' })
    sessionState.value = { status: 'authenticated', data: { user: { id: 'user-1' } } }
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/resume/save' && init?.method === 'POST') {
        return Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'Save failed' }) })
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ resumes: [], count: 0, limit: 3 }),
      })
    }))

    render(<ResumeBuilderPage />)
    await screen.findByText('Resume editor')
    fireEvent.click(screen.getByRole('button', { name: 'Save mocked resume' }))

    await waitFor(() => expect(screen.getByRole('link', { name: 'Back to job setup' })).toBeTruthy())
    expect(screen.queryByRole('link', { name: 'Continue to job setup' })).toBeNull()
  })

  it('ignores a delayed resume response from the previous signed-in account', async () => {
    searchState.params = new URLSearchParams({ id: JOB_ID })
    sessionState.value = { status: 'authenticated', data: { user: { id: 'user-a' } } }
    let resolveUserA!: (value: unknown) => void
    const userAList = new Promise((resolve) => { resolveUserA = resolve })
    const mockFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const headers = init?.headers as Record<string, string> | undefined
      const userId = headers?.['x-origin-user-id']
      if (url === '/api/resume/save' && userId === 'user-a') return userAList
      if (url === '/api/resume/save' && userId === 'user-b') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ resumes: [{ id: JOB_ID }], count: 1, limit: 3 }),
        })
      }
      if (url === `/api/resume/save?id=${JOB_ID}` && userId === 'user-b') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: JOB_ID, name: 'B Resume', summary: 'Owned by B' }),
        })
      }
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) })
    })
    vi.stubGlobal('fetch', mockFetch)

    const view = render(<ResumeBuilderPage />)
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(
      '/api/resume/save',
      expect.objectContaining({ headers: { 'x-origin-user-id': 'user-a' } }),
    ))

    sessionState.value = { status: 'authenticated', data: { user: { id: 'user-b' } } }
    view.rerender(<ResumeBuilderPage />)
    expect(await screen.findByText(`Loaded resume: B Resume (${JOB_ID})`)).toBeTruthy()

    await act(async () => {
      resolveUserA({
        ok: true,
        json: () => Promise.resolve({ resumes: [{ id: JOB_ID }], count: 1, limit: 3 }),
      })
    })

    expect(screen.getByText(`Loaded resume: B Resume (${JOB_ID})`)).toBeTruthy()
    expect(mockFetch).not.toHaveBeenCalledWith(
      `/api/resume/save?id=${JOB_ID}`,
      expect.objectContaining({ headers: { 'x-origin-user-id': 'user-a' } }),
    )
  })

  it('ignores a delayed parser response that began from account A after account B loads', async () => {
    searchState.params = new URLSearchParams({ id: JOB_ID })
    sessionState.value = { status: 'authenticated', data: { user: { id: 'user-a' } } }
    let resolveUserAParse!: (value: unknown) => void
    const userAParse = new Promise((resolve) => { resolveUserAParse = resolve })
    const mockFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const headers = init?.headers as Record<string, string> | undefined
      const userId = headers?.['x-origin-user-id']
      if (url === '/api/resume/save') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ resumes: [{ id: JOB_ID }], count: 1, limit: 3 }),
        })
      }
      if (url === `/api/resume/save?id=${JOB_ID}` && userId === 'user-a') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: JOB_ID, name: 'A Resume', fullText: 'User A private text' }),
        })
      }
      if (url === '/api/resume/parse') return userAParse
      if (url === `/api/resume/save?id=${JOB_ID}` && userId === 'user-b') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: JOB_ID, name: 'B Resume', summary: 'Owned by B' }),
        })
      }
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) })
    })
    vi.stubGlobal('fetch', mockFetch)

    const view = render(<ResumeBuilderPage />)
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(
      '/api/resume/parse',
      expect.objectContaining({ method: 'POST' }),
    ))

    sessionState.value = { status: 'authenticated', data: { user: { id: 'user-b' } } }
    view.rerender(<ResumeBuilderPage />)
    expect(await screen.findByText(`Loaded resume: B Resume (${JOB_ID})`)).toBeTruthy()

    await act(async () => {
      resolveUserAParse({
        ok: true,
        json: () => Promise.resolve({ resume: { name: 'Parsed A Secret', summary: 'User A only' } }),
      })
    })
    expect(screen.getByText(`Loaded resume: B Resume (${JOB_ID})`)).toBeTruthy()
    expect(screen.queryByText(/Parsed A Secret/)).toBeNull()
  })

  it('does not unlock the Jobs continuation when a save completes after an account switch', async () => {
    searchState.params = new URLSearchParams({ return: '/jobs/start' })
    sessionState.value = { status: 'authenticated', data: { user: { id: 'user-a' } } }
    let resolveSave!: (value: unknown) => void
    const saveResponse = new Promise((resolve) => { resolveSave = resolve })
    const mockFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/resume/save' && init?.method === 'POST') return saveResponse
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ resumes: [], count: 0, limit: 3 }),
      })
    })
    vi.stubGlobal('fetch', mockFetch)

    const view = render(<ResumeBuilderPage />)
    await screen.findByText('Resume editor')
    fireEvent.click(screen.getByRole('button', { name: 'Save mocked resume' }))
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(
      '/api/resume/save',
      expect.objectContaining({ method: 'POST' }),
    ))
    const saveCall = mockFetch.mock.calls.find((call) => call[1]?.method === 'POST')
    expect(JSON.parse(String(saveCall?.[1]?.body))).toEqual(expect.objectContaining({ originUserId: 'user-a' }))

    sessionState.value = { status: 'authenticated', data: { user: { id: 'user-b' } } }
    view.rerender(<ResumeBuilderPage />)
    await screen.findByText('Resume editor')
    await act(async () => {
      resolveSave({ ok: true, json: () => Promise.resolve({ id: 'resume-a' }) })
    })

    await waitFor(() => expect(mockSaveResult).toHaveBeenCalledWith(expect.objectContaining({ code: 'SESSION_CHANGED' })))
    expect(screen.queryByRole('link', { name: 'Continue to job setup' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Back to job setup' })).toBeTruthy()
  })

  it('preserves unsaved edits across a transient session refresh for the same account', async () => {
    sessionState.value = { status: 'authenticated', data: { user: { id: 'user-a' } } }
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ resumes: [], count: 0, limit: 3 }),
    })))

    const view = render(<ResumeBuilderPage />)
    await screen.findByText('Resume editor')
    fireEvent.click(screen.getByRole('button', { name: 'Type private edits' }))

    sessionState.value = { status: 'loading', data: null }
    view.rerender(<ResumeBuilderPage />)
    expect(screen.getByRole('status', { name: 'Refreshing sign-in status' })).toBeTruthy()

    sessionState.value = { status: 'authenticated', data: { user: { id: 'user-a' } } }
    view.rerender(<ResumeBuilderPage />)
    expect(await screen.findByText('Loaded resume: User A private edits (unsaved)')).toBeTruthy()
  })

  it('clears account-A resume-cap state before account B cap data resolves', async () => {
    sessionState.value = { status: 'authenticated', data: { user: { id: 'user-a' } } }
    let resolveUserBCap!: (value: unknown) => void
    const userBCap = new Promise((resolve) => { resolveUserBCap = resolve })
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined
      if (headers?.['x-origin-user-id'] === 'user-b') return userBCap
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ resumes: [], count: 3, limit: 3 }),
      })
    }))

    const view = render(<ResumeBuilderPage />)
    expect(await screen.findByText(/used all 3 resume slots/i)).toBeTruthy()

    sessionState.value = { status: 'authenticated', data: { user: { id: 'user-b' } } }
    view.rerender(<ResumeBuilderPage />)
    await screen.findByText('Resume editor')
    expect(screen.queryByText(/used all 3 resume slots/i)).toBeNull()

    await act(async () => {
      resolveUserBCap({
        ok: true,
        json: () => Promise.resolve({ resumes: [], count: 0, limit: 3 }),
      })
    })
  })

  it.each([
    ['another account', { status: 'authenticated' as const, data: { user: { id: 'user-b' } } }],
    ['signed out', { status: 'unauthenticated' as const, data: null }],
  ])('remounts away unsaved account-A editor state when the session becomes %s', async (_label, nextSession) => {
    sessionState.value = { status: 'authenticated', data: { user: { id: 'user-a' } } }
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ resumes: [], count: 0, limit: 3 }),
    })))

    const view = render(<ResumeBuilderPage />)
    await screen.findByText('Resume editor')
    fireEvent.click(screen.getByRole('button', { name: 'Type private edits' }))
    expect(screen.getByText('Loaded resume: User A private edits (unsaved)')).toBeTruthy()

    sessionState.value = nextSession
    view.rerender(<ResumeBuilderPage />)

    expect(await screen.findByText('Loaded resume: new (unsaved)')).toBeTruthy()
    expect(screen.queryByText('Loaded resume: User A private edits (unsaved)')).toBeNull()
  })
})
