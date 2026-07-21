import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

const { mockFetch, mockPush, mockRequireAuth, searchState, sessionState } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockPush: vi.fn(),
  mockRequireAuth: vi.fn(),
  searchState: { jobId: '507f1f77bcf86cd799439011' },
  sessionState: {
    status: 'unauthenticated' as 'authenticated' | 'unauthenticated' | 'loading',
    userId: null as string | null,
  },
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => new URLSearchParams(searchState.jobId ? `jobId=${searchState.jobId}` : ''),
}))
vi.mock('next-auth/react', () => ({
  useSession: () => ({
    status: sessionState.status,
    data: sessionState.userId ? { user: { id: sessionState.userId } } : null,
  }),
}))
vi.mock('@shared/providers/AuthGateProvider', () => ({ useAuthGate: () => ({ requireAuth: mockRequireAuth }) }))
vi.mock('@shared/ui/FileDropzone', () => ({
  default: ({ onFileSelect }: { onFileSelect: (file: File) => void }) => (
    <button type="button" onClick={() => onFileSelect(new File(['resume'], 'resume.pdf', { type: 'application/pdf' }))}>
      Test upload
    </button>
  ),
}))

import TailorPage from '../page'

const JOB_ID = '507f1f77bcf86cd799439011'
const JOB_B_ID = '507f1f77bcf86cd799439012'
const RESUME_A_ID = '607f1f77bcf86cd799439011'
const RESUME_B_ID = '607f1f77bcf86cd799439012'
const USER_A_ID = '707f1f77bcf86cd799439011'
const USER_B_ID = '707f1f77bcf86cd799439012'
const INPUT_HASH = 'a'.repeat(64)
const PENDING_ASSOCIATION_KEY = 'jobs:tailor-pending-association:v1'
const RESULT = {
  tailoredResume: 'TAILORED RESUME',
  changes: [],
  matchScore: 82,
  missingKeywords: [],
  addedKeywords: ['TypeScript'],
}
const response = (value: unknown, ok = true, status = ok ? 200 : 404) => Promise.resolve({ ok, status, json: () => Promise.resolve(value) })

function pendingRecord(overrides: { jobId?: string; sourceJdHash?: string; savedAt?: number; originUserId?: string } = {}) {
  return {
    version: 1,
    savedAt: overrides.savedAt ?? Date.now(),
    payload: {
      jobId: overrides.jobId ?? JOB_ID,
      sourceJdHash: overrides.sourceJdHash ?? INPUT_HASH,
      tailoredText: RESULT.tailoredResume,
      originUserId: overrides.originUserId ?? USER_A_ID,
      matchScore: RESULT.matchScore,
      addedKeywords: RESULT.addedKeywords,
      missingKeywords: RESULT.missingKeywords,
    },
    result: RESULT,
    resumeFileName: 'Recovered resume',
  }
}

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch)
  mockFetch.mockReset()
  mockPush.mockReset()
  mockRequireAuth.mockReset()
  sessionState.status = 'unauthenticated'
  sessionState.userId = null
  searchState.jobId = JOB_ID
  sessionStorage.clear()
})

function enterResume(text = 'MY RESUME') {
  fireEvent.change(screen.getByPlaceholderText('Paste your resume here. To upload a PDF or DOCX, sign in.'), { target: { value: text } })
}

async function switchSession(view: ReturnType<typeof render>, userId: string, waitForJobInput = true) {
  const detailCallsBefore = mockFetch.mock.calls.filter(([url]) => String(url) === `/api/jobs/${JOB_ID}`).length
  sessionState.status = 'authenticated'
  sessionState.userId = userId
  view.rerender(<TailorPage />)
  await waitFor(() => {
    expect(mockFetch.mock.calls.filter(([url]) => String(url) === `/api/jobs/${JOB_ID}`).length).toBeGreaterThan(detailCallsBefore)
  })
  if (waitForJobInput) {
    await waitFor(() => {
      expect((screen.getByPlaceholderText('Paste the job description here...') as HTMLTextAreaElement).value).not.toBe('')
    })
  }
}

describe('Tailor tracked-job capability', () => {
  it('scrubs account-bound inputs when the initial job context reports account deletion', async () => {
    sessionState.status = 'authenticated'
    sessionState.userId = USER_A_ID
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) {
        return response({ code: 'ACCOUNT_UNAVAILABLE' }, false, 401)
      }
      if (url === '/api/resume/save') return response({ resumes: [] })
      return response({})
    })

    render(<TailorPage />)

    expect(await screen.findByText(/Account deletion has started or completed/i)).toBeTruthy()
    expect(screen.queryByLabelText('Job description')).toBeNull()
    expect(screen.queryByLabelText('Company name')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Test upload' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Tailor My Resume' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Sign in to attach' })).toBeNull()
    expect(screen.queryByText('82%')).toBeNull()
  })

  it('discards a held result when attachment reports account unavailability', async () => {
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return response({
        gated: false,
        postingState: 'live',
        company: 'Acme',
        jd: 'CURRENT JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      })
      if (url === '/api/resume/save') return response({ resumes: [] })
      if (url === '/api/resume/tailor') return response(RESULT)
      if (url === `/api/jobs/${JOB_ID}/tailored`) {
        return response({ code: 'ACCOUNT_UNAVAILABLE' }, false, 401)
      }
      return response({})
    })

    const view = render(<TailorPage />)
    await screen.findByText(/Using the job description for Acme/i)
    enterResume()
    await switchSession(view, USER_A_ID)
    fireEvent.click(screen.getByRole('button', { name: 'Tailor My Resume' }))

    expect(await screen.findByText(/Account deletion has started or completed/i)).toBeTruthy()
    expect(screen.queryByText('82%')).toBeNull()
    expect(screen.queryByText('TAILORED RESUME')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Sign in to attach' })).toBeNull()
    expect(screen.queryByLabelText('Job description')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Test upload' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Tailor My Resume' })).toBeNull()
    expect(sessionStorage.getItem(PENDING_ASSOCIATION_KEY)).toBeNull()
  })

  it('scrubs in-flight tracked-job inputs when the Tailor provider boundary reports account unavailability', async () => {
    let resolveTailor!: (value: { ok: boolean; status: number; json: () => Promise<unknown> }) => void
    const tailorResponse = new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>((resolve) => {
      resolveTailor = resolve
    })
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return response({
        gated: false,
        postingState: 'live',
        company: 'Acme',
        jd: 'CURRENT JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      })
      if (url === '/api/resume/save') return response({ resumes: [] })
      if (url === '/api/resume/tailor') return tailorResponse
      return response({})
    })

    const view = render(<TailorPage />)
    await screen.findByText(/Using the job description for Acme/i)
    enterResume('PRIVATE RESUME')
    await switchSession(view, USER_A_ID)
    fireEvent.click(screen.getByRole('button', { name: 'Tailor My Resume' }))

    await act(async () => {
      resolveTailor({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ code: 'ACCOUNT_UNAVAILABLE' }),
      })
    })

    expect(await screen.findByText(/Account deletion has started or completed/i)).toBeTruthy()
    expect(screen.queryByLabelText('Job description')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Test upload' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Tailor My Resume' })).toBeNull()
    expect(screen.queryByText('82%')).toBeNull()
    expect(mockFetch.mock.calls.some(([url]) => String(url) === `/api/jobs/${JOB_ID}/tailored`)).toBe(false)
  })

  it('keeps account deletion terminal across late success, job navigation, and session changes', async () => {
    type DeferredResponse = { ok: boolean; status: number; json: () => Promise<unknown> }
    let resolveSavedResumes!: (value: DeferredResponse) => void
    let resolveTailor!: (value: DeferredResponse) => void
    const savedResumesResponse = new Promise<DeferredResponse>((resolve) => {
      resolveSavedResumes = resolve
    })
    const tailorResponse = new Promise<DeferredResponse>((resolve) => {
      resolveTailor = resolve
    })
    sessionState.status = 'authenticated'
    sessionState.userId = USER_A_ID
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}` || url === `/api/jobs/${JOB_B_ID}`) return response({
        gated: false,
        postingState: 'live',
        company: 'Acme',
        jd: 'CURRENT JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      })
      if (url === '/api/resume/save') return savedResumesResponse
      if (url === '/api/documents/upload') return response({ text: 'PRIVATE RESUME', fileName: 'resume.pdf' })
      if (url === '/api/resume/tailor') return tailorResponse
      return response({})
    })

    const view = render(<TailorPage />)
    await screen.findByText(/Using the job description for Acme/i)
    fireEvent.click(screen.getByRole('button', { name: 'Test upload' }))
    await screen.findByText('resume.pdf')
    fireEvent.click(screen.getByRole('button', { name: 'Tailor My Resume' }))
    await waitFor(() => {
      expect(mockFetch.mock.calls.some(([url]) => String(url) === '/api/resume/tailor')).toBe(true)
    })

    await act(async () => {
      resolveSavedResumes({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ code: 'ACCOUNT_UNAVAILABLE' }),
      })
    })

    expect(await screen.findByText(/Account deletion has started or completed/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Test upload' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Tailor My Resume' })).toBeNull()
    expect(screen.queryByLabelText('Resume text')).toBeNull()
    expect(screen.queryByLabelText('Job description')).toBeNull()
    expect(screen.queryByText('PRIVATE RESUME')).toBeNull()

    searchState.jobId = JOB_B_ID
    sessionState.userId = USER_B_ID
    view.rerender(<TailorPage />)

    await act(async () => {
      resolveTailor({
        ok: true,
        status: 200,
        json: () => Promise.resolve(RESULT),
      })
    })

    expect(screen.getByText(/Account deletion has started or completed/i)).toBeTruthy()
    expect(screen.queryByText('82%')).toBeNull()
    expect(screen.queryByText('TAILORED RESUME')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Test upload' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Tailor My Resume' })).toBeNull()
    expect(mockFetch.mock.calls.some(([url]) => String(url) === `/api/jobs/${JOB_B_ID}`)).toBe(false)
  })

  it('does not let a superseded Tailor rejection overwrite a terminal session message', async () => {
    type DeferredResponse = { ok: boolean; status: number; json: () => Promise<unknown> }
    let resolveSavedResumes!: (value: DeferredResponse) => void
    let rejectTailor!: (reason: Error) => void
    const savedResumesResponse = new Promise<DeferredResponse>((resolve) => {
      resolveSavedResumes = resolve
    })
    const tailorResponse = new Promise<DeferredResponse>((_resolve, reject) => {
      rejectTailor = reject
    })
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return response({
        gated: false,
        postingState: 'live',
        company: 'Acme',
        jd: 'CURRENT JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      })
      if (url === '/api/resume/save') return savedResumesResponse
      if (url === '/api/resume/tailor') return tailorResponse
      return response({})
    })

    const view = render(<TailorPage />)
    await screen.findByText(/Using the job description for Acme/i)
    enterResume('PRIVATE RESUME')
    await switchSession(view, USER_A_ID)
    fireEvent.click(screen.getByRole('button', { name: 'Tailor My Resume' }))
    await waitFor(() => {
      expect(mockFetch.mock.calls.some(([url]) => String(url) === '/api/resume/tailor')).toBe(true)
    })

    await act(async () => {
      resolveSavedResumes({
        ok: false,
        status: 409,
        json: () => Promise.resolve({ code: 'SESSION_CHANGED' }),
      })
    })
    expect(await screen.findByText(/sign-in account changed while saved resumes were loading/i)).toBeTruthy()

    await act(async () => {
      rejectTailor(new Error('late network failure'))
    })
    expect(screen.getByText(/sign-in account changed while saved resumes were loading/i)).toBeTruthy()
    expect(screen.queryByText('Network error')).toBeNull()
  })

  it('attaches an archived-owner result only when the server grants Tailor', async () => {
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return response({
        gated: false,
        postingState: 'archived',
        company: 'Acme',
        jd: 'RETAINED JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      })
      if (url === '/api/resume/tailor') return response(RESULT)
      if (url === `/api/jobs/${JOB_ID}/tailored`) return response({ ok: true })
      return response({})
    })

    const view = render(<TailorPage />)

    expect(await screen.findByText(/Using the retained archived description for Acme/i)).toBeTruthy()
    enterResume()
    await switchSession(view, USER_A_ID)
    fireEvent.click(screen.getByRole('button', { name: 'Tailor My Resume' }))

    expect(await screen.findByText('Attached to this tracked job.')).toBeTruthy()
    expect(mockFetch.mock.calls.some(([url]) => String(url) === `/api/jobs/${JOB_ID}/tailored`)).toBe(true)
    const associationCall = mockFetch.mock.calls.find(([url]) => String(url) === `/api/jobs/${JOB_ID}/tailored`)
    expect(JSON.parse(String(associationCall?.[1]?.body))).toMatchObject({
      sourceJdHash: INPUT_HASH,
      originUserId: USER_A_ID,
    })
  })

  it.each(['restricted', 'snapshot-only'] as const)('detaches a %s deep link and never posts a false job association', async (postingState) => {
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return response({
        gated: false,
        postingState,
        company: 'Acme',
        capabilities: { tailor: false },
      })
      if (url === '/api/resume/tailor') return response(RESULT)
      return response({})
    })

    render(<TailorPage />)

    expect(await screen.findByText(/saved description is unavailable/i)).toBeTruthy()
    enterResume()
    fireEvent.change(screen.getByPlaceholderText('Paste the job description here...'), { target: { value: 'A GENERIC JD' } })
    fireEvent.click(screen.getByRole('button', { name: 'Tailor My Resume' }))

    expect(await screen.findByText(/general tailoring result and is not attached/i)).toBeTruthy()
    expect(mockFetch.mock.calls.some(([url]) => String(url) === `/api/jobs/${JOB_ID}/tailored`)).toBe(false)
  })

  it('keeps the result but reports when lifecycle changes before association persistence', async () => {
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return response({
        gated: false,
        postingState: 'archived',
        company: 'Acme',
        jd: 'RETAINED JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      })
      if (url === '/api/resume/tailor') return response(RESULT)
      if (url === `/api/jobs/${JOB_ID}/tailored`) {
        return response({ error: 'posting not found', code: 'JOB_NOT_FOUND' }, false)
      }
      return response({})
    })

    const view = render(<TailorPage />)
    await screen.findByText(/Using the retained archived description/i)
    enterResume()
    await switchSession(view, USER_A_ID)
    fireEvent.click(screen.getByRole('button', { name: 'Tailor My Resume' }))

    expect(await screen.findByText(/wasn’t attached because the saved job description or posting lifecycle changed/i)).toBeTruthy()
    await waitFor(() => expect(screen.getByText('82%')).toBeTruthy())
  })

  it('keeps an edited tracked-job prefill general and never posts a false association', async () => {
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return response({
        gated: false,
        postingState: 'archived',
        company: 'Acme',
        jd: 'RETAINED JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      })
      if (url === '/api/resume/tailor') return response(RESULT)
      return response({})
    })

    render(<TailorPage />)
    await screen.findByText(/Using the retained archived description/i)
    enterResume()
    fireEvent.change(screen.getByPlaceholderText('Paste the job description here...'), { target: { value: 'EDITED JD' } })

    expect(await screen.findByText(/You edited the saved job context/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Tailor My Resume' }))

    expect(await screen.findByText(/general tailoring result and is not attached/i)).toBeTruthy()
    expect(mockFetch.mock.calls.some(([url]) => String(url) === `/api/jobs/${JOB_ID}/tailored`)).toBe(false)
  })

  it('ignores a late job-A response after navigation to job B', async () => {
    let resolveJobA!: (value: { ok: boolean; status: number; json: () => Promise<unknown> }) => void
    const jobAResponse = new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>((resolve) => {
      resolveJobA = resolve
    })
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return jobAResponse
      if (url === `/api/jobs/${JOB_B_ID}`) return response({
        gated: false,
        postingState: 'live',
        company: 'Beta',
        jd: 'JOB B JD',
        tailorInputHash: 'b'.repeat(64),
        capabilities: { tailor: true },
      })
      return response({})
    })

    const view = render(<TailorPage />)
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}`, expect.objectContaining({ signal: expect.anything() })))
    searchState.jobId = JOB_B_ID
    view.rerender(<TailorPage />)

    expect(await screen.findByText(/Using the job description for Beta/i)).toBeTruthy()
    resolveJobA({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        gated: false,
        postingState: 'archived',
        company: 'Stale Acme',
        jd: 'STALE JOB A JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      }),
    })

    await waitFor(() => {
      expect((screen.getByPlaceholderText('Paste the job description here...') as HTMLTextAreaElement).value).toBe('JOB B JD')
      expect((screen.getByPlaceholderText('Company name (optional)') as HTMLInputElement).value).toBe('Beta')
    })
    expect(screen.queryByDisplayValue('STALE JOB A JD')).toBeNull()
  })

  it('does not render or post a delayed user-A result after the active session switches to user B', async () => {
    let resolveTailor!: (value: { ok: boolean; status: number; json: () => Promise<unknown> }) => void
    const tailorResponse = new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>((resolve) => {
      resolveTailor = resolve
    })
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return response({
        gated: false,
        postingState: 'live',
        company: 'Acme',
        jd: 'CURRENT JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      })
      if (url === '/api/resume/tailor') return tailorResponse
      return response({})
    })

    const view = render(<TailorPage />)
    await screen.findByText(/Using the job description for Acme/i)
    enterResume('USER A RESUME')
    await switchSession(view, USER_A_ID)
    fireEvent.click(screen.getByRole('button', { name: 'Tailor My Resume' }))

    await switchSession(view, USER_B_ID)
    await act(async () => {
      resolveTailor({ ok: true, status: 200, json: () => Promise.resolve(RESULT) })
    })

    expect(screen.queryByText('82%')).toBeNull()
    expect(mockFetch.mock.calls.some(([url]) => String(url) === `/api/jobs/${JOB_ID}/tailored`)).toBe(false)
  })

  it('scrubs user-A content when the server detects a session switch before attachment', async () => {
    let resolveAssociation!: (value: { ok: boolean; status: number; json: () => Promise<unknown> }) => void
    const associationResponse = new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>((resolve) => {
      resolveAssociation = resolve
    })
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return response({
        gated: false,
        postingState: 'live',
        company: 'Acme',
        jd: 'CURRENT JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      })
      if (url === '/api/resume/tailor') return response(RESULT)
      if (url === `/api/jobs/${JOB_ID}/tailored`) return associationResponse
      return response({})
    })

    const view = render(<TailorPage />)
    await screen.findByText(/Using the job description for Acme/i)
    enterResume('USER A PRIVATE RESUME')
    await switchSession(view, USER_A_ID)
    fireEvent.click(screen.getByRole('button', { name: 'Tailor My Resume' }))

    await waitFor(() => {
      expect(mockFetch.mock.calls.some(([url]) => String(url) === `/api/jobs/${JOB_ID}/tailored`)).toBe(true)
    })
    expect(screen.queryByText('82%')).toBeNull()
    expect(screen.queryByText('TAILORED RESUME')).toBeNull()

    await act(async () => {
      resolveAssociation({
        ok: false,
        status: 409,
        json: () => Promise.resolve({ error: 'sign-in session changed', code: 'SESSION_CHANGED' }),
      })
    })
    expect(await screen.findByText(/sign-in account changed while Tailor was running/i)).toBeTruthy()
    expect(screen.queryByText('82%')).toBeNull()
    expect(screen.queryByText('TAILORED RESUME')).toBeNull()
    expect(sessionStorage.getItem(PENDING_ASSOCIATION_KEY)).toBeNull()
  })

  it('binds generation to the run-start user and scrubs a server-detected account switch', async () => {
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return response({
        gated: false,
        postingState: 'live',
        company: 'Acme',
        jd: 'CURRENT JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      })
      if (url === '/api/resume/tailor') {
        return response({ error: 'sign-in session changed', code: 'SESSION_CHANGED' }, false, 409)
      }
      return response({})
    })

    const view = render(<TailorPage />)
    await screen.findByText(/Using the job description for Acme/i)
    enterResume('USER A PRIVATE RESUME')
    await switchSession(view, USER_A_ID)
    fireEvent.click(screen.getByRole('button', { name: 'Tailor My Resume' }))

    expect(await screen.findByText(/sign-in account changed before tailoring completed/i)).toBeTruthy()
    const call = mockFetch.mock.calls.find(([url]) => String(url) === '/api/resume/tailor')
    expect(call?.[1]?.headers).toMatchObject({ 'x-origin-user-id': USER_A_ID })
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ originUserId: USER_A_ID })
    expect(screen.queryByText('82%')).toBeNull()
    expect(mockFetch.mock.calls.some(([url]) => String(url) === `/api/jobs/${JOB_ID}/tailored`)).toBe(false)
  })

  it('binds upload to the captured user and scrubs a server-detected account switch', async () => {
    sessionState.status = 'authenticated'
    sessionState.userId = USER_A_ID
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return response({
        gated: false,
        postingState: 'live',
        company: 'Acme',
        jd: 'CURRENT JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      })
      if (url === '/api/resume/save') return response({ resumes: [] })
      if (url === '/api/documents/upload') {
        return response({ error: 'sign-in session changed', code: 'SESSION_CHANGED' }, false, 409)
      }
      return response({})
    })

    render(<TailorPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Test upload' }))

    expect(await screen.findByText(/sign-in account changed before the upload completed/i)).toBeTruthy()
    const call = mockFetch.mock.calls.find(([url]) => String(url) === '/api/documents/upload')
    expect(call?.[1]?.headers).toMatchObject({ 'x-origin-user-id': USER_A_ID })
    expect((call?.[1]?.body as FormData).get('originUserId')).toBeNull()
    expect(screen.queryByText('USER A PRIVATE RESUME')).toBeNull()
  })

  it('binds Save as New Resume to the result origin and never navigates on an account conflict', async () => {
    mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return response({
        gated: false,
        postingState: 'live',
        company: 'Acme',
        jd: 'CURRENT JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      })
      if (url === '/api/resume/tailor') return response(RESULT)
      if (url === `/api/jobs/${JOB_ID}/tailored`) return response({ ok: true })
      if (url === '/api/resume/save' && init?.method === 'POST') {
        return response({ error: 'sign-in session changed', code: 'SESSION_CHANGED' }, false, 409)
      }
      if (url === '/api/resume/save') return response({ resumes: [] })
      return response({})
    })

    const view = render(<TailorPage />)
    await screen.findByText(/Using the job description for Acme/i)
    enterResume('USER A PRIVATE RESUME')
    await switchSession(view, USER_A_ID)
    fireEvent.click(screen.getByRole('button', { name: 'Tailor My Resume' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Save as New Resume' }))

    expect(await screen.findByText(/sign-in account changed before this resume could be saved/i)).toBeTruthy()
    const saveCall = mockFetch.mock.calls.find(([url, init]) => String(url) === '/api/resume/save' && init?.method === 'POST')
    expect(JSON.parse(String(saveCall?.[1]?.body))).toMatchObject({
      fullText: 'TAILORED RESUME',
      originUserId: USER_A_ID,
    })
    expect(mockPush).not.toHaveBeenCalled()
    expect(screen.queryByText('TAILORED RESUME')).toBeNull()
  })

  it('scrubs the tracked-job result when Save as New Resume reports account unavailability', async () => {
    mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return response({
        gated: false,
        postingState: 'live',
        company: 'Acme',
        jd: 'CURRENT JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      })
      if (url === '/api/resume/tailor') return response(RESULT)
      if (url === `/api/jobs/${JOB_ID}/tailored`) return response({ ok: true })
      if (url === '/api/resume/save' && init?.method === 'POST') {
        return response({ error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' }, false, 401)
      }
      if (url === '/api/resume/save') return response({ resumes: [] })
      return response({})
    })

    const view = render(<TailorPage />)
    await screen.findByText(/Using the job description for Acme/i)
    enterResume('PRIVATE RESUME')
    await switchSession(view, USER_A_ID)
    fireEvent.click(screen.getByRole('button', { name: 'Tailor My Resume' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Save as New Resume' }))

    expect(await screen.findByText(/Account deletion has started or completed/i)).toBeTruthy()
    expect(screen.queryByText('TAILORED RESUME')).toBeNull()
    expect(screen.queryByLabelText('Job description')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Test upload' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Tailor My Resume' })).toBeNull()
    expect(sessionStorage.getItem(PENDING_ASSOCIATION_KEY)).toBeNull()
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('synchronously masks user-A result content when the resolved client identity changes to user B', async () => {
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return response({
        gated: false,
        postingState: 'live',
        company: 'Acme',
        jd: 'CURRENT JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      })
      if (url === '/api/resume/tailor') return response(RESULT)
      if (url === `/api/jobs/${JOB_ID}/tailored`) return response({ ok: true })
      if (url === '/api/resume/save') return response({ resumes: [] })
      return response({})
    })

    const view = render(<TailorPage />)
    await screen.findByText(/Using the job description for Acme/i)
    enterResume('USER A PRIVATE RESUME')
    await switchSession(view, USER_A_ID)
    fireEvent.click(screen.getByRole('button', { name: 'Tailor My Resume' }))
    expect(await screen.findByText('82%')).toBeTruthy()

    sessionState.userId = USER_B_ID
    view.rerender(<TailorPage />)

    expect(screen.queryByText('82%')).toBeNull()
    expect(screen.queryByText('TAILORED RESUME')).toBeNull()
    expect(screen.queryByText('USER A PRIVATE RESUME')).toBeNull()
  })

  it('holds an unverified association failure out of view and retries only the attachment', async () => {
    let associationAttempts = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return response({
        gated: false,
        postingState: 'live',
        company: 'Acme',
        jd: 'CURRENT JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      })
      if (url === '/api/resume/tailor') return response(RESULT)
      if (url === `/api/jobs/${JOB_ID}/tailored`) {
        associationAttempts += 1
        return associationAttempts === 1
          ? response({ error: 'temporary' }, false, 503)
          : response({ ok: true })
      }
      return response({})
    })

    const view = render(<TailorPage />)
    await screen.findByText(/Using the job description for Acme/i)
    enterResume()
    await switchSession(view, USER_A_ID)
    fireEvent.click(screen.getByRole('button', { name: 'Tailor My Resume' }))

    const status = await screen.findByRole('status')
    expect(status.getAttribute('aria-atomic')).toBe('true')
    expect(status.textContent).toMatch(/couldn’t verify the active account/i)
    expect(screen.queryByText('82%')).toBeNull()
    expect(screen.queryByText('TAILORED RESUME')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry attachment' }))

    expect(await screen.findByText('Attached to this tracked job.')).toBeTruthy()
    expect(associationAttempts).toBe(2)
    expect(mockFetch.mock.calls.filter(([url]) => String(url) === '/api/resume/tailor')).toHaveLength(1)
  })

  it('holds a rejected association request out of view until an identity-proving retry succeeds', async () => {
    let associationAttempts = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return response({
        gated: false,
        postingState: 'live',
        company: 'Acme',
        jd: 'CURRENT JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      })
      if (url === '/api/resume/tailor') return response(RESULT)
      if (url === `/api/jobs/${JOB_ID}/tailored`) {
        associationAttempts += 1
        return associationAttempts === 1
          ? Promise.reject(new Error('gateway unavailable'))
          : response({ ok: true })
      }
      return response({})
    })

    const view = render(<TailorPage />)
    await screen.findByText(/Using the job description for Acme/i)
    enterResume()
    await switchSession(view, USER_A_ID)
    fireEvent.click(screen.getByRole('button', { name: 'Tailor My Resume' }))

    expect(await screen.findByText(/result remains hidden/i)).toBeTruthy()
    expect(screen.queryByText('82%')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry attachment' }))

    expect(await screen.findByText('Attached to this tracked job.')).toBeTruthy()
    expect(screen.getByText('82%')).toBeTruthy()
  })

  it('reveals a result after a structured transient response proves the originating identity', async () => {
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return response({
        gated: false,
        postingState: 'live',
        company: 'Acme',
        jd: 'CURRENT JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      })
      if (url === '/api/resume/tailor') return response(RESULT)
      if (url === `/api/jobs/${JOB_ID}/tailored`) {
        return response({ code: 'ATTACHMENT_TEMPORARY', identityVerified: true }, false, 503)
      }
      return response({})
    })

    const view = render(<TailorPage />)
    await screen.findByText(/Using the job description for Acme/i)
    enterResume()
    await switchSession(view, USER_A_ID)
    fireEvent.click(screen.getByRole('button', { name: 'Tailor My Resume' }))

    expect(await screen.findByText(/temporary service error prevented attachment/i)).toBeTruthy()
    expect(screen.getByText('82%')).toBeTruthy()
  })

  it('does not register or post an unbound continuation when the originating user is unavailable', async () => {
    let associationAttempts = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return response({
        gated: false,
        postingState: 'live',
        company: 'Acme',
        jd: 'CURRENT JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      })
      if (url === '/api/resume/tailor') return response(RESULT)
      if (url === `/api/jobs/${JOB_ID}/tailored`) {
        associationAttempts += 1
        return associationAttempts === 1
          ? response({ error: 'sign in required' }, false, 401)
          : response({ ok: true })
      }
      return response({})
    })

    const view = render(<TailorPage />)
    await screen.findByText(/Using the job description for Acme/i)
    enterResume()
    fireEvent.click(screen.getByRole('button', { name: 'Tailor My Resume' }))

    expect(await screen.findByText(/session expired/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to attach' }))
    expect(await screen.findByText(/couldn’t safely preserve this result for sign-in/i)).toBeTruthy()
    expect(mockRequireAuth).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(PENDING_ASSOCIATION_KEY)).toBeNull()
    expect(mockPush).not.toHaveBeenCalled()

    sessionState.status = 'authenticated'
    sessionState.userId = USER_A_ID
    view.rerender(<TailorPage />)
    await waitFor(() => expect(associationAttempts).toBe(0))
    expect(screen.queryByText('Attached to this tracked job.')).toBeNull()
    expect(sessionStorage.getItem(PENDING_ASSOCIATION_KEY)).toBeNull()
  })

  it('restores the result and retries the attachment after a full OAuth page round-trip', async () => {
    let associationAttempts = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return response({
        gated: false,
        postingState: 'live',
        company: 'Acme',
        jd: 'CURRENT JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      })
      if (url === '/api/resume/tailor') return response(RESULT)
      if (url === `/api/jobs/${JOB_ID}/tailored`) {
        associationAttempts += 1
        return associationAttempts === 1
          ? response({ error: 'sign in required' }, false, 401)
          : response({ ok: true })
      }
      return response({})
    })

    const firstView = render(<TailorPage />)
    await screen.findByText(/Using the job description for Acme/i)
    enterResume()
    await switchSession(firstView, USER_A_ID)
    fireEvent.click(screen.getByRole('button', { name: 'Tailor My Resume' }))
    await screen.findByText(/session expired/i)
    expect(sessionStorage.getItem(PENDING_ASSOCIATION_KEY)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to attach' }))
    expect(sessionStorage.getItem(PENDING_ASSOCIATION_KEY)).not.toBeNull()
    firstView.unmount()

    render(<TailorPage />)

    expect(await screen.findByText('Attached to this tracked job.')).toBeTruthy()
    expect(screen.getByText('82%')).toBeTruthy()
    expect(associationAttempts).toBe(2)
    expect(mockFetch.mock.calls.filter(([url]) => String(url) === '/api/resume/tailor')).toHaveLength(1)
    expect(sessionStorage.getItem(PENDING_ASSOCIATION_KEY)).toBeNull()
  })

  it('retains a cancelled OAuth continuation while signed out and recovers it for the same user later', async () => {
    sessionStorage.setItem(PENDING_ASSOCIATION_KEY, JSON.stringify(pendingRecord()))
    let detailAttempts = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) {
        detailAttempts += 1
        return detailAttempts === 1
          ? response({ gated: true, id: JOB_ID })
          : response({
              gated: false,
              postingState: 'live',
              company: 'Acme',
              jd: 'CURRENT JD',
              tailorInputHash: INPUT_HASH,
              capabilities: { tailor: true },
            })
      }
      if (url === `/api/jobs/${JOB_ID}/tailored`) return response({ ok: true })
      return response({})
    })

    const view = render(<TailorPage />)
    await screen.findByText(/couldn't verify the saved job context right now/i)
    expect(sessionStorage.getItem(PENDING_ASSOCIATION_KEY)).not.toBeNull()
    expect(screen.queryByText('82%')).toBeNull()
    expect(mockFetch.mock.calls.some(([url]) => String(url) === `/api/jobs/${JOB_ID}/tailored`)).toBe(false)

    await switchSession(view, USER_A_ID, false)

    expect(await screen.findByText('Attached to this tracked job.')).toBeTruthy()
    expect(screen.getByText('82%')).toBeTruthy()
    expect(sessionStorage.getItem(PENDING_ASSOCIATION_KEY)).toBeNull()
  })

  it('clears another user’s continuation without rendering or posting it', async () => {
    sessionState.status = 'authenticated'
    sessionState.userId = USER_B_ID
    sessionStorage.setItem(PENDING_ASSOCIATION_KEY, JSON.stringify(pendingRecord({ originUserId: USER_A_ID })))
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return response({
        gated: false,
        postingState: 'live',
        company: 'Acme',
        jd: 'CURRENT JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      })
      return response({})
    })

    render(<TailorPage />)
    await screen.findByText(/Using the job description for Acme/i)
    await waitFor(() => expect(sessionStorage.getItem(PENDING_ASSOCIATION_KEY)).toBeNull())

    expect(screen.queryByText('82%')).toBeNull()
    expect(mockFetch.mock.calls.some(([url]) => String(url) === `/api/jobs/${JOB_ID}/tailored`)).toBe(false)
  })

  it('discards an oversized pending artifact instead of truncating and attaching it', async () => {
    sessionState.status = 'authenticated'
    sessionState.userId = USER_A_ID
    const record = pendingRecord()
    record.payload.tailoredText = 'x'.repeat(60_001)
    record.result = { ...record.result, tailoredResume: 'x'.repeat(60_001) }
    sessionStorage.setItem(PENDING_ASSOCIATION_KEY, JSON.stringify(record))
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return response({
        gated: false,
        postingState: 'live',
        company: 'Acme',
        jd: 'CURRENT JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      })
      return response({})
    })

    render(<TailorPage />)
    await screen.findByText(/Using the job description for Acme/i)
    await waitFor(() => expect(sessionStorage.getItem(PENDING_ASSOCIATION_KEY)).toBeNull())

    expect(screen.queryByText('82%')).toBeNull()
    expect(mockFetch.mock.calls.some(([url]) => String(url) === `/api/jobs/${JOB_ID}/tailored`)).toBe(false)
  })

  it('shows an oversized live result without attempting an impossible tracked-job attachment', async () => {
    const oversizedResult = { ...RESULT, tailoredResume: 'x'.repeat(60_001) }
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return response({
        gated: false,
        postingState: 'live',
        company: 'Acme',
        jd: 'CURRENT JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      })
      if (url === '/api/resume/tailor') return response(oversizedResult)
      return response({})
    })

    const view = render(<TailorPage />)
    await screen.findByText(/Using the job description for Acme/i)
    enterResume()
    await switchSession(view, USER_A_ID)
    fireEvent.click(screen.getByRole('button', { name: 'Tailor My Resume' }))

    expect(await screen.findByText(/exceeds the tracked-job attachment limit/i)).toBeTruthy()
    expect(screen.getByText('82%')).toBeTruthy()
    expect(mockFetch.mock.calls.some(([url]) => String(url) === `/api/jobs/${JOB_ID}/tailored`)).toBe(false)
    expect(sessionStorage.getItem(PENDING_ASSOCIATION_KEY)).toBeNull()
  })

  it.each([
    ['401', () => response({ error: 'session refreshing' }, false, 401)],
    ['500', () => response({ error: 'temporary' }, false, 500)],
    ['network failure', () => Promise.reject(new Error('offline'))],
    ['gated shell', () => response({ gated: true, id: JOB_ID })],
    ['invalid response', () => response({ unexpected: true })],
  ])('retains a same-user continuation through a transient %s detail failure and recovers on retry', async (_label, firstDetail) => {
    sessionState.status = 'authenticated'
    sessionState.userId = USER_A_ID
    sessionStorage.setItem(PENDING_ASSOCIATION_KEY, JSON.stringify(pendingRecord()))
    let detailAttempts = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) {
        detailAttempts += 1
        return detailAttempts === 1
          ? firstDetail()
          : response({
              gated: false,
              postingState: 'live',
              company: 'Acme',
              jd: 'CURRENT JD',
              tailorInputHash: INPUT_HASH,
              capabilities: { tailor: true },
            })
      }
      if (url === `/api/jobs/${JOB_ID}/tailored`) return response({ ok: true })
      return response({})
    })

    render(<TailorPage />)

    expect(await screen.findByText(/couldn’t reverify the saved job context yet/i)).toBeTruthy()
    expect(screen.queryByText('82%')).toBeNull()
    expect(screen.queryByText('TAILORED RESUME')).toBeNull()
    expect(sessionStorage.getItem(PENDING_ASSOCIATION_KEY)).not.toBeNull()
    expect(mockFetch.mock.calls.some(([url]) => String(url) === `/api/jobs/${JOB_ID}/tailored`)).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Retry job verification' }))

    expect(await screen.findByText('Attached to this tracked job.')).toBeTruthy()
    expect(detailAttempts).toBe(2)
    expect(mockFetch.mock.calls.filter(([url]) => String(url) === `/api/jobs/${JOB_ID}/tailored`)).toHaveLength(1)
    expect(sessionStorage.getItem(PENDING_ASSOCIATION_KEY)).toBeNull()
  })

  it.each([
    ['expired', () => pendingRecord({ savedAt: Date.now() - 11 * 60 * 1000 })],
    ['another job', () => pendingRecord({ jobId: JOB_B_ID })],
    ['an older JD version', () => pendingRecord({ sourceJdHash: 'b'.repeat(64) })],
  ])('discards %s OAuth recovery data without attaching it', async (_label, makeRecord) => {
    sessionState.status = 'authenticated'
    sessionState.userId = USER_A_ID
    sessionStorage.setItem(PENDING_ASSOCIATION_KEY, JSON.stringify(makeRecord()))
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return response({
        gated: false,
        postingState: 'live',
        company: 'Acme',
        jd: 'CURRENT JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      })
      return response({})
    })

    render(<TailorPage />)
    await screen.findByText(/Using the job description for Acme/i)
    await waitFor(() => expect(sessionStorage.getItem(PENDING_ASSOCIATION_KEY)).toBeNull())
    expect(mockFetch.mock.calls.some(([url]) => String(url) === `/api/jobs/${JOB_ID}/tailored`)).toBe(false)
    expect(screen.queryByText('82%')).toBeNull()
  })

  it('retains recovered data for a retryable failure, then clears it after retry succeeds', async () => {
    sessionState.status = 'authenticated'
    sessionState.userId = USER_A_ID
    sessionStorage.setItem(PENDING_ASSOCIATION_KEY, JSON.stringify(pendingRecord()))
    let associationAttempts = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return response({
        gated: false,
        postingState: 'live',
        company: 'Acme',
        jd: 'CURRENT JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      })
      if (url === `/api/jobs/${JOB_ID}/tailored`) {
        associationAttempts += 1
        return associationAttempts === 1
          ? response({ error: 'temporary' }, false, 503)
          : response({ ok: true })
      }
      return response({})
    })

    render(<TailorPage />)

    expect(await screen.findByText(/couldn’t verify the active account/i)).toBeTruthy()
    expect(screen.queryByText('82%')).toBeNull()
    expect(screen.queryByText('TAILORED RESUME')).toBeNull()
    expect(sessionStorage.getItem(PENDING_ASSOCIATION_KEY)).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry attachment' }))

    expect(await screen.findByText('Attached to this tracked job.')).toBeTruthy()
    expect(associationAttempts).toBe(2)
    expect(sessionStorage.getItem(PENDING_ASSOCIATION_KEY)).toBeNull()
  })

  it('clears recovered data when the server reports a terminal lifecycle conflict', async () => {
    sessionState.status = 'authenticated'
    sessionState.userId = USER_A_ID
    sessionStorage.setItem(PENDING_ASSOCIATION_KEY, JSON.stringify(pendingRecord()))
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return response({
        gated: false,
        postingState: 'live',
        company: 'Acme',
        jd: 'CURRENT JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      })
      if (url === `/api/jobs/${JOB_ID}/tailored`) {
        return response({ error: 'changed', code: 'JOB_DESCRIPTION_CHANGED' }, false, 409)
      }
      return response({})
    })

    render(<TailorPage />)

    expect(await screen.findByText(/posting lifecycle changed/i)).toBeTruthy()
    expect(screen.getByText('82%')).toBeTruthy()
    expect(sessionStorage.getItem(PENDING_ASSOCIATION_KEY)).toBeNull()
  })

  it('routes to dedicated OAuth sign-in after a 401 even when the cached session says authenticated', async () => {
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return response({
        gated: false,
        postingState: 'live',
        company: 'Acme',
        jd: 'CURRENT JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      })
      if (url === '/api/resume/tailor') return response(RESULT)
      if (url === `/api/jobs/${JOB_ID}/tailored`) return response({ error: 'sign in required' }, false, 401)
      return response({})
    })

    const view = render(<TailorPage />)
    await screen.findByText(/Using the job description for Acme/i)
    enterResume()
    await switchSession(view, USER_A_ID)
    fireEvent.click(screen.getByRole('button', { name: 'Tailor My Resume' }))
    await screen.findByText(/session expired/i)
    expect(screen.queryByText('82%')).toBeNull()
    expect(screen.queryByText('TAILORED RESUME')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to attach' }))

    expect(mockPush).toHaveBeenCalledWith(
      `/signin?callbackUrl=${encodeURIComponent(`/resume/tailor?jobId=${JOB_ID}`)}`,
    )
    expect(mockRequireAuth).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(PENDING_ASSOCIATION_KEY)).not.toBeNull()
  })

  it('stays on the result and shows recovery guidance when sessionStorage is unavailable', async () => {
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return response({
        gated: false,
        postingState: 'live',
        company: 'Acme',
        jd: 'CURRENT JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      })
      if (url === '/api/resume/tailor') return response(RESULT)
      if (url === `/api/jobs/${JOB_ID}/tailored`) return response({ error: 'sign in required' }, false, 401)
      return response({})
    })

    const view = render(<TailorPage />)
    await screen.findByText(/Using the job description for Acme/i)
    enterResume()
    await switchSession(view, USER_A_ID)
    fireEvent.click(screen.getByRole('button', { name: 'Tailor My Resume' }))
    await screen.findByText(/session expired/i)

    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in to attach' }))
      expect(await screen.findByText(/couldn’t safely preserve this result for sign-in/i)).toBeTruthy()
      expect(mockPush).not.toHaveBeenCalled()
      expect(sessionStorage.getItem(PENDING_ASSOCIATION_KEY)).toBeNull()
      expect(screen.queryByText('82%')).toBeNull()
    } finally {
      setItem.mockRestore()
    }
  })

  it('associates the saved resume captured at request start when the user switches resumes mid-run', async () => {
    sessionState.status = 'authenticated'
    sessionState.userId = USER_A_ID
    let resolveTailor!: (value: { ok: boolean; status: number; json: () => Promise<unknown> }) => void
    const tailorResponse = new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>((resolve) => {
      resolveTailor = resolve
    })
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return response({
        gated: false,
        postingState: 'live',
        company: 'Acme',
        jd: 'CURRENT JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      })
      if (url === '/api/resume/save') return response({ resumes: [
        { id: RESUME_A_ID, name: 'Resume A', targetRole: '' },
        { id: RESUME_B_ID, name: 'Resume B', targetRole: '' },
      ] })
      if (url === `/api/resume/save?id=${RESUME_A_ID}`) return response({ fullText: 'RESUME A TEXT' })
      if (url === `/api/resume/save?id=${RESUME_B_ID}`) return response({ fullText: 'RESUME B TEXT' })
      if (url === '/api/resume/tailor') return tailorResponse
      if (url === `/api/jobs/${JOB_ID}/tailored`) return response({ ok: true })
      return response({})
    })

    render(<TailorPage />)
    const select = await screen.findByRole('combobox')
    fireEvent.change(select, { target: { value: RESUME_A_ID } })
    await screen.findByText('(saved)')
    fireEvent.click(screen.getByRole('button', { name: 'Tailor My Resume' }))
    fireEvent.change(select, { target: { value: RESUME_B_ID } })
    await waitFor(() => expect(screen.getAllByText('Resume B')).toHaveLength(2))

    await act(async () => {
      resolveTailor({ ok: true, status: 200, json: () => Promise.resolve(RESULT) })
    })
    expect(await screen.findByText('Attached to this tracked job.')).toBeTruthy()

    const tailorCall = mockFetch.mock.calls.find(([url]) => String(url) === '/api/resume/tailor')
    expect(JSON.parse(String(tailorCall?.[1]?.body))).toMatchObject({ resumeText: 'RESUME A TEXT' })
    const associationCall = mockFetch.mock.calls.find(([url]) => String(url) === `/api/jobs/${JOB_ID}/tailored`)
    expect(JSON.parse(String(associationCall?.[1]?.body))).toMatchObject({ sourceResumeId: RESUME_A_ID })
  })

  it('ignores an inverted saved-resume A response after resume B has loaded', async () => {
    sessionState.status = 'authenticated'
    sessionState.userId = USER_A_ID
    let resolveResumeA!: (value: { ok: boolean; status: number; json: () => Promise<unknown> }) => void
    const resumeAResponse = new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>((resolve) => {
      resolveResumeA = resolve
    })
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return response({
        gated: false,
        postingState: 'live',
        company: 'Acme',
        jd: 'CURRENT JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      })
      if (url === '/api/resume/save') return response({ resumes: [
        { id: RESUME_A_ID, name: 'Resume A', targetRole: '' },
        { id: RESUME_B_ID, name: 'Resume B', targetRole: '' },
      ] })
      if (url === `/api/resume/save?id=${RESUME_A_ID}`) return resumeAResponse
      if (url === `/api/resume/save?id=${RESUME_B_ID}`) return response({ fullText: 'RESUME B TEXT' })
      if (url === '/api/resume/tailor') return response(RESULT)
      if (url === `/api/jobs/${JOB_ID}/tailored`) return response({ ok: true })
      return response({})
    })

    render(<TailorPage />)
    const select = await screen.findByRole('combobox')
    fireEvent.change(select, { target: { value: RESUME_A_ID } })
    fireEvent.change(select, { target: { value: RESUME_B_ID } })
    await waitFor(() => expect(screen.getAllByText('Resume B')).toHaveLength(2))
    await act(async () => {
      resolveResumeA({ ok: true, status: 200, json: () => Promise.resolve({ fullText: 'STALE RESUME A TEXT' }) })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Tailor My Resume' }))
    expect(await screen.findByText('Attached to this tracked job.')).toBeTruthy()
    const tailorCall = mockFetch.mock.calls.find(([url]) => String(url) === '/api/resume/tailor')
    expect(JSON.parse(String(tailorCall?.[1]?.body))).toMatchObject({ resumeText: 'RESUME B TEXT' })
    const associationCall = mockFetch.mock.calls.find(([url]) => String(url) === `/api/jobs/${JOB_ID}/tailored`)
    expect(JSON.parse(String(associationCall?.[1]?.body))).toMatchObject({ sourceResumeId: RESUME_B_ID })
  })

  it('never renders a server-B resume list when the saved stale client is bound to user A', async () => {
    sessionState.status = 'authenticated'
    sessionState.userId = USER_A_ID
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return response({
        gated: false,
        postingState: 'live',
        company: 'Acme',
        jd: 'CURRENT JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      })
      if (url === '/api/resume/save') {
        return response({
          error: 'sign-in session changed',
          code: 'SESSION_CHANGED',
          resumes: [{ id: RESUME_B_ID, name: 'USER B PRIVATE RESUME', targetRole: '' }],
        }, false, 409)
      }
      return response({})
    })

    render(<TailorPage />)

    expect(await screen.findByText(/sign-in account changed while saved resumes were loading/i)).toBeTruthy()
    const listCall = mockFetch.mock.calls.find(([url]) => String(url) === '/api/resume/save')
    expect(listCall?.[1]?.headers).toMatchObject({ 'x-origin-user-id': USER_A_ID })
    expect(screen.queryByText('USER B PRIVATE RESUME')).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByText(/Using the job description for Acme/i)).toBeNull()
  })

  it('scrubs Tailor when the saved-resume list reports account deletion', async () => {
    sessionState.status = 'authenticated'
    sessionState.userId = USER_A_ID
    sessionStorage.setItem('JOBS_TARGET', JSON.stringify({ role: 'Private Role' }))
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return response({
        gated: false,
        postingState: 'live',
        company: 'Acme',
        jd: 'CURRENT JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      })
      if (url === '/api/resume/save') {
        return response({
          code: 'ACCOUNT_UNAVAILABLE',
          resumes: [{ id: RESUME_A_ID, name: 'PRIVATE RESUME', targetRole: '' }],
        }, false, 401)
      }
      return response({})
    })

    render(<TailorPage />)

    expect(await screen.findByText(/Account deletion has started or completed/i)).toBeTruthy()
    expect(screen.queryByText('PRIVATE RESUME')).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByText(/Using the job description for Acme/i)).toBeNull()
    expect(sessionStorage.getItem('JOBS_TARGET')).toBeNull()
  })

  it('never renders server-B fullText and scrubs the user-A list on a saved-resume detail conflict', async () => {
    sessionState.status = 'authenticated'
    sessionState.userId = USER_A_ID
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return response({
        gated: false,
        postingState: 'live',
        company: 'Acme',
        jd: 'CURRENT JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      })
      if (url === '/api/resume/save') {
        return response({ resumes: [{ id: RESUME_A_ID, name: 'Resume A', targetRole: '' }] })
      }
      if (url === `/api/resume/save?id=${RESUME_A_ID}`) {
        return response({
          error: 'sign-in session changed',
          code: 'SESSION_CHANGED',
          fullText: 'USER B PRIVATE FULL TEXT',
        }, false, 409)
      }
      return response({})
    })

    render(<TailorPage />)
    const select = await screen.findByRole('combobox')
    fireEvent.change(select, { target: { value: RESUME_A_ID } })

    expect(await screen.findByText(/sign-in account changed while this resume was loading/i)).toBeTruthy()
    const detailCall = mockFetch.mock.calls.find(([url]) => String(url) === `/api/resume/save?id=${RESUME_A_ID}`)
    expect(detailCall?.[1]?.headers).toMatchObject({ 'x-origin-user-id': USER_A_ID })
    expect(screen.queryByText('USER B PRIVATE FULL TEXT')).toBeNull()
    expect(screen.queryByRole('option', { name: 'Resume A' })).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('scrubs the saved-resume list and text when resume detail reports account deletion', async () => {
    sessionState.status = 'authenticated'
    sessionState.userId = USER_A_ID
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return response({
        gated: false,
        postingState: 'live',
        company: 'Acme',
        jd: 'CURRENT JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      })
      if (url === '/api/resume/save') {
        return response({ resumes: [{ id: RESUME_A_ID, name: 'Resume A', targetRole: '' }] })
      }
      if (url === `/api/resume/save?id=${RESUME_A_ID}`) {
        return response({
          code: 'ACCOUNT_UNAVAILABLE',
          fullText: 'PRIVATE RESUME TEXT',
        }, false, 401)
      }
      return response({})
    })

    render(<TailorPage />)
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: RESUME_A_ID } })

    expect(await screen.findByText(/Account deletion has started or completed/i)).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'Resume A' })).toBeNull()
    expect(screen.queryByText('PRIVATE RESUME TEXT')).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('clears loaded user-A resume state and loads only user-B resumes after an account switch', async () => {
    sessionState.status = 'authenticated'
    sessionState.userId = USER_A_ID
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return response({
        gated: false,
        postingState: 'live',
        company: 'Acme',
        jd: 'CURRENT JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      })
      if (url === '/api/resume/save') {
        return sessionState.userId === USER_A_ID
          ? response({ resumes: [{ id: RESUME_A_ID, name: 'Resume A', targetRole: '' }] })
          : response({ resumes: [{ id: RESUME_B_ID, name: 'Resume B', targetRole: '' }] })
      }
      if (url === `/api/resume/save?id=${RESUME_A_ID}`) return response({ fullText: 'USER A PRIVATE RESUME' })
      return response({})
    })

    const view = render(<TailorPage />)
    const select = await screen.findByRole('combobox')
    await screen.findByRole('option', { name: 'Resume A' })
    fireEvent.change(select, { target: { value: RESUME_A_ID } })
    await screen.findByText('(saved)')

    await switchSession(view, USER_B_ID)
    await screen.findByRole('option', { name: 'Resume B' })

    expect(screen.queryByRole('option', { name: 'Resume A' })).toBeNull()
    expect(screen.queryByText('(saved)')).toBeNull()
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('')
    expect((screen.getByRole('button', { name: 'Tailor My Resume' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('ignores a late user-A full-resume response after switching to user B', async () => {
    sessionState.status = 'authenticated'
    sessionState.userId = USER_A_ID
    let resolveResumeA!: (value: { ok: boolean; status: number; json: () => Promise<unknown> }) => void
    const resumeAResponse = new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>((resolve) => {
      resolveResumeA = resolve
    })
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return response({
        gated: false,
        postingState: 'live',
        company: 'Acme',
        jd: 'CURRENT JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      })
      if (url === '/api/resume/save') {
        return sessionState.userId === USER_A_ID
          ? response({ resumes: [{ id: RESUME_A_ID, name: 'Resume A', targetRole: '' }] })
          : response({ resumes: [{ id: RESUME_B_ID, name: 'Resume B', targetRole: '' }] })
      }
      if (url === `/api/resume/save?id=${RESUME_A_ID}`) return resumeAResponse
      return response({})
    })

    const view = render(<TailorPage />)
    const select = await screen.findByRole('combobox')
    await screen.findByRole('option', { name: 'Resume A' })
    fireEvent.change(select, { target: { value: RESUME_A_ID } })
    await switchSession(view, USER_B_ID)
    await screen.findByRole('option', { name: 'Resume B' })
    await act(async () => {
      resolveResumeA({ ok: true, status: 200, json: () => Promise.resolve({ fullText: 'LATE USER A PRIVATE RESUME' }) })
    })

    expect(screen.queryByText('(saved)')).toBeNull()
    expect(screen.queryByRole('option', { name: 'Resume A' })).toBeNull()
    expect((screen.getByRole('button', { name: 'Tailor My Resume' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('ignores a late user-A resume-list response after user B’s list has loaded', async () => {
    sessionState.status = 'authenticated'
    sessionState.userId = USER_A_ID
    let resolveListA!: (value: { ok: boolean; status: number; json: () => Promise<unknown> }) => void
    const listAResponse = new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>((resolve) => {
      resolveListA = resolve
    })
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return response({
        gated: false,
        postingState: 'live',
        company: 'Acme',
        jd: 'CURRENT JD',
        tailorInputHash: INPUT_HASH,
        capabilities: { tailor: true },
      })
      if (url === '/api/resume/save') {
        return sessionState.userId === USER_A_ID
          ? listAResponse
          : response({ resumes: [{ id: RESUME_B_ID, name: 'Resume B', targetRole: '' }] })
      }
      return response({})
    })

    const view = render(<TailorPage />)
    await screen.findByText(/Using the job description for Acme/i)
    await switchSession(view, USER_B_ID)
    await screen.findByRole('option', { name: 'Resume B' })
    await act(async () => {
      resolveListA({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ resumes: [{ id: RESUME_A_ID, name: 'Resume A', targetRole: '' }] }),
      })
    })

    expect(screen.queryByRole('option', { name: 'Resume A' })).toBeNull()
    expect(screen.getByRole('option', { name: 'Resume B' })).toBeTruthy()
  })
})
