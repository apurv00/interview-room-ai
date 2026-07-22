import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const { mockFetch, mockPush } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockPush: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))
vi.mock('@shared/ui/AuthGateModal', () => ({
  default: ({ reason }: { reason: string | null }) => reason ? <div>auth gate: {reason}</div> : null,
}))

import JobDetailPage from '../page'
import { STORAGE_KEYS } from '@shared/storageKeys'

const JOB_ID = '507f1f77bcf86cd799439011'
const RETAKE_ID = '507f1f77bcf86cd799439099'
const APPLY_OPTION_ID = `ao2_${'a'.repeat(43)}`
const ALTERNATE_OPTION_ID = `ao2_${'b'.repeat(43)}`
const BASE_DETAIL = {
  id: JOB_ID,
  title: 'Frontend Engineer',
  company: 'Acme',
  locations: ['Remote'],
  isRemote: true,
  gated: false,
  postingState: 'live' as const,
  capabilities: {
    apply: false,
    viewSource: false,
    xray: true,
    tailor: true,
    practice: true,
    atsCheck: false,
  },
  jd: 'Build accessible React interfaces.',
  applyOptions: [],
  allApplyOptionsDemoted: false,
  flags: { staffing: false, shortJd: false, repost: false },
  application: null,
}
const XRAY = {
  role: 'Frontend Engineer',
  inferredDomain: 'attacker-controlled-role',
  keyThemes: ['accessibility'],
  requirements: [],
}
const LIVE_APPLY_DETAIL = {
  ...BASE_DETAIL,
  capabilities: {
    apply: true,
    viewSource: true,
    xray: false,
    tailor: true,
    practice: false,
    atsCheck: false,
  },
  applyOptions: [{ optionId: APPLY_OPTION_ID, url: 'https://apply.example/job', tier: 'direct-ats' }],
}
const LIVE_APPLY_DETAIL_WITH_ALTERNATE = {
  ...LIVE_APPLY_DETAIL,
  applyOptions: [
    ...LIVE_APPLY_DETAIL.applyOptions,
    {
      optionId: ALTERNATE_OPTION_ID,
      url: 'https://careers.example/job',
      tier: 'employer',
      viaSite: 'Company careers',
    },
  ],
}
const TRACKED_INTERVIEW_DETAIL = {
  ...BASE_DETAIL,
  capabilities: { ...BASE_DETAIL.capabilities, xray: false },
  application: {
    applicationId: 'app-1',
    status: 'interview_scheduled',
    practiceCount: 1,
    ats: { state: 'none' as const },
  },
}

function jsonResponse(value: unknown, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(value) })
}

function accountUnavailableResponse() {
  return Promise.resolve({
    ok: false,
    status: 401,
    json: () => Promise.resolve({ code: 'ACCOUNT_UNAVAILABLE' }),
  })
}

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch)
  mockFetch.mockReset()
  mockPush.mockReset()
  localStorage.clear()
  vi.stubGlobal('open', vi.fn(() => ({ opener: window, name: '', close: vi.fn() })))
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  window.history.replaceState({}, '', `/jobs/${JOB_ID}`)
})

describe('Job detail Practice readiness', () => {
  it('scrubs the initial projection when account deletion makes the session unavailable', async () => {
    localStorage.setItem(STORAGE_KEYS.INTERVIEW_CONFIG, JSON.stringify({
      jobDescription: 'PRIVATE JOB DESCRIPTION',
      jobsHandoffToken: 'signed-private-token',
      attribution: { source: 'jobs', jobId: JOB_ID },
    }))
    localStorage.setItem(`${STORAGE_KEYS.INTERVIEW_CONFIG}:user-a`, 'scoped private config')
    localStorage.setItem(STORAGE_KEYS.PENDING_RETAKE_PARENT, RETAKE_ID)
    localStorage.setItem('unrelated-preference', 'keep-me')
    mockFetch.mockImplementation((input: RequestInfo | URL) => (
      String(input) === `/api/jobs/${JOB_ID}`
        ? Promise.resolve({
            ok: false,
            status: 401,
            json: () => Promise.resolve({ code: 'ACCOUNT_UNAVAILABLE' }),
          })
        : jsonResponse({})
    ))

    render(<JobDetailPage params={{ id: JOB_ID }} />)

    expect(await screen.findByText('Your account is unavailable.')).toBeTruthy()
    expect(screen.getByText(/Account deletion has started or completed/i)).toBeTruthy()
    expect(screen.queryByText(/Sign in to read/i)).toBeNull()
    expect(screen.queryByText(/couldn.t confirm this posting/i)).toBeNull()
    expect(localStorage.getItem(STORAGE_KEYS.INTERVIEW_CONFIG)).toBeNull()
    expect(localStorage.getItem(`${STORAGE_KEYS.INTERVIEW_CONFIG}:user-a`)).toBeNull()
    expect(localStorage.getItem(STORAGE_KEYS.PENDING_RETAKE_PARENT)).toBeNull()
    expect(localStorage.getItem('unrelated-preference')).toBe('keep-me')
  })

  it('scrubs an already-rendered job when Save reports account unavailability', async () => {
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return jsonResponse(LIVE_APPLY_DETAIL)
      if (url.endsWith('/save')) {
        return Promise.resolve({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ code: 'ACCOUNT_UNAVAILABLE' }),
        })
      }
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Your account is unavailable.')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: LIVE_APPLY_DETAIL.title })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Apply ↗' })).toBeNull()
    expect(screen.queryByText('auth gate: save_job')).toBeNull()
  })

  it('keeps an ordinary Save 401 on the sign-in gate without discarding the job', async () => {
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return jsonResponse(LIVE_APPLY_DETAIL)
      if (url.endsWith('/save')) {
        return Promise.resolve({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: 'sign in required' }),
        })
      }
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }))

    expect(await screen.findByText('auth gate: save_job')).toBeTruthy()
    expect(screen.getByRole('heading', { name: LIVE_APPLY_DETAIL.title })).toBeTruthy()
    expect(screen.queryByText('Your account is unavailable.')).toBeNull()
  })

  it('renders Tracked from the server application projection without issuing a Save mutation', async () => {
    const trackedDetail = {
      ...LIVE_APPLY_DETAIL,
      application: {
        applicationId: 'app-1',
        status: 'saved',
        practiceCount: 0,
        ats: { state: 'none' as const },
      },
    }
    mockFetch.mockImplementation((input: RequestInfo | URL) => (
      String(input) === `/api/jobs/${JOB_ID}` ? jsonResponse(trackedDetail) : jsonResponse({})
    ))

    render(<JobDetailPage params={{ id: JOB_ID }} />)

    const tracked = await screen.findByRole('button', { name: 'Tracked ✓' })
    expect(tracked).toBeDisabled()
    fireEvent.click(tracked)
    expect(mockFetch.mock.calls.some(([url]) => String(url).endsWith('/save'))).toBe(false)
  })

  it('shows Tracked only after the post-mutation server projection contains an application', async () => {
    const trackedDetail = {
      ...LIVE_APPLY_DETAIL,
      application: {
        applicationId: 'app-1',
        status: 'saved',
        practiceCount: 0,
        ats: { state: 'none' as const },
      },
    }
    let detailCalls = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) {
        detailCalls += 1
        return jsonResponse(detailCalls === 1 ? LIVE_APPLY_DETAIL : trackedDetail)
      }
      if (url.endsWith('/save')) return jsonResponse({ ok: true })
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('button', { name: 'Tracked ✓' })).toBeDisabled()
    expect(detailCalls).toBe(2)
  })

  it('keeps Save single-flight across rapid same-tick clicks', async () => {
    let resolveSave!: (response: unknown) => void
    const pendingSave = new Promise((resolve) => { resolveSave = resolve })
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return jsonResponse(LIVE_APPLY_DETAIL)
      if (url.endsWith('/save')) return pendingSave
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    const save = await screen.findByRole('button', { name: 'Save' })
    fireEvent.click(save)
    fireEvent.click(save)

    const saveCalls = mockFetch.mock.calls.filter(([url]) => String(url).endsWith('/save'))
    expect(saveCalls).toHaveLength(1)
    await act(async () => {
      resolveSave({ ok: false, status: 503, json: () => Promise.resolve({}) })
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.t save this job/i)
  })

  it('keeps Save unconfirmed and reports a safe error when the authority refresh has no application', async () => {
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return jsonResponse(LIVE_APPLY_DETAIL)
      if (url.endsWith('/save')) return jsonResponse({ ok: true })
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.t confirm the save/i)
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('scrubs the job when the post-Save detail refresh reports account unavailability', async () => {
    let detailCalls = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) {
        detailCalls += 1
        return detailCalls === 1
          ? jsonResponse(LIVE_APPLY_DETAIL)
          : Promise.resolve({
              ok: false,
              status: 401,
              json: () => Promise.resolve({ code: 'ACCOUNT_UNAVAILABLE' }),
            })
      }
      if (url.endsWith('/save')) return jsonResponse({ ok: true })
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Your account is unavailable.')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: LIVE_APPLY_DETAIL.title })).toBeNull()
  })

  it.each([
    [404, /isn.t available anymore/i],
    [410, /closed or expired/i],
  ] as const)('replaces stale actions with the authoritative %i state after Save', async (status, safeCopy) => {
    let detailCalls = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) {
        detailCalls += 1
        return detailCalls === 1
          ? jsonResponse(LIVE_APPLY_DETAIL)
          : Promise.resolve({
              ok: false,
              status,
              json: () => Promise.resolve({}),
            })
      }
      if (url.endsWith('/save')) return jsonResponse({ ok: true })
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }))

    expect(await screen.findByText(safeCopy)).toBeTruthy()
    expect(screen.queryByRole('heading', { name: LIVE_APPLY_DETAIL.title })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Apply ↗' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Tailor resume' })).toBeNull()
    expect(screen.queryByText(LIVE_APPLY_DETAIL.jd)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('scrubs the job when ATS-check reports account unavailability', async () => {
    const atsDetail = {
      ...BASE_DETAIL,
      capabilities: { ...BASE_DETAIL.capabilities, xray: false, atsCheck: true },
      application: {
        applicationId: 'app1',
        status: 'saved',
        practiceCount: 0,
        ats: { state: 'none' as const },
      },
    }
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return jsonResponse(atsDetail)
      if (url.endsWith('/ats-check')) return accountUnavailableResponse()
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Check my resume against this JD' }))

    expect(await screen.findByText('Your account is unavailable.')).toBeTruthy()
    expect(screen.queryByText(/Could not start the check/i)).toBeNull()
  })

  it('scrubs the job when deferred Practice email reports account unavailability', async () => {
    const interviewDetail = {
      ...BASE_DETAIL,
      capabilities: { ...BASE_DETAIL.capabilities, xray: false, practice: true },
      practiceRole: 'frontend',
      practiceHandoffToken: 'server-signed-token',
      practiceExperience: '7+' as const,
      application: {
        applicationId: 'app1',
        status: 'interview_scheduled',
        practiceCount: 1,
        ats: { state: 'none' as const },
      },
    }
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return jsonResponse(interviewDetail)
      if (url.endsWith('/practice-link-email')) return accountUnavailableResponse()
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    fireEvent.click(await screen.findByRole('button', { name: /Email me this practice link/i }))

    expect(await screen.findByText('Your account is unavailable.')).toBeTruthy()
    expect(screen.queryByText(/Email links aren.t available yet/i)).toBeNull()
  })

  it('acknowledges only the deferred-email request, without inventing delivery timing', async () => {
    const interviewDetail = {
      ...BASE_DETAIL,
      capabilities: { ...BASE_DETAIL.capabilities, xray: false, practice: true },
      practiceRole: 'frontend',
      practiceHandoffToken: 'server-signed-token',
      practiceExperience: '7+' as const,
      application: {
        applicationId: 'app1',
        status: 'interview_scheduled',
        practiceCount: 1,
        ats: { state: 'none' as const },
      },
    }
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return jsonResponse(interviewDetail)
      if (url.endsWith('/practice-link-email')) return jsonResponse({ ok: true })
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    fireEvent.click(await screen.findByRole('button', { name: /Email me this practice link/i }))

    expect(await screen.findByText('Request received — check your inbox.')).toBeTruthy()
    expect(screen.queryByText(/sent|this evening|tonight/i)).toBeNull()
  })

  it.each([
    ['a server failure', () => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) })],
    ['invalid JSON', () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new Error('invalid JSON')) })],
    ['a malformed projection', () => jsonResponse({ id: JOB_ID })],
    ['a projection for another job', () => jsonResponse({ ...BASE_DETAIL, id: RETAKE_ID })],
    ['a projection without lifecycle authority', () => jsonResponse({
      ...BASE_DETAIL,
      postingState: undefined,
    })],
    ['malformed capabilities', () => jsonResponse({
      ...BASE_DETAIL,
      capabilities: { ...BASE_DETAIL.capabilities, atsCheck: 'yes' },
    })],
    ['a malformed apply option', () => jsonResponse({
      ...BASE_DETAIL,
      applyOptions: [{ optionId: 'raw-database-id', url: 'https://apply.example/job', tier: 'direct-ats' }],
    })],
    ['a malformed application ATS projection', () => jsonResponse({
      ...TRACKED_INTERVIEW_DETAIL,
      application: { ...TRACKED_INTERVIEW_DETAIL.application, ats: { state: 'complete' } },
    })],
    ['a malformed Practice projection', () => jsonResponse({
      ...BASE_DETAIL,
      practiceExperience: '3-to-6',
    })],
  ])('shows a retryable server error for %s on initial load', async (_case, detailResponse) => {
    mockFetch.mockImplementation((input: RequestInfo | URL) => (
      String(input) === `/api/jobs/${JOB_ID}` ? detailResponse() : jsonResponse({})
    ))

    render(<JobDetailPage params={{ id: JOB_ID }} />)

    expect(await screen.findByText(/couldn.t load this posting right now/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(screen.queryByText(/isn.t available anymore/i)).toBeNull()
  })

  it.each([
    ['a projection for another job', { ...TRACKED_INTERVIEW_DETAIL, id: RETAKE_ID, title: 'Wrong job' }],
    ['a projection without lifecycle authority', {
      ...TRACKED_INTERVIEW_DETAIL,
      postingState: undefined,
    }],
    ['a malformed nested application', {
      ...TRACKED_INTERVIEW_DETAIL,
      title: 'Malformed job',
      application: { ...TRACKED_INTERVIEW_DETAIL.application, ats: {} },
    }],
  ])('preserves the current projection when a background refetch returns %s', async (_case, backgroundProjection) => {
    let detailCalls = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) {
        detailCalls += 1
        return jsonResponse(detailCalls === 1 ? TRACKED_INTERVIEW_DETAIL : backgroundProjection)
      }
      if (url.endsWith('/interview-date')) return jsonResponse({ ok: true })
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    const heading = await screen.findByRole('heading', { name: BASE_DETAIL.title })
    expect(screen.getByRole('button', { name: 'Tracked ✓' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Tomorrow' }))
    await waitFor(() => expect(detailCalls).toBe(2))

    expect(heading.isConnected).toBe(true)
    expect(screen.getByRole('heading', { name: BASE_DETAIL.title })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: /Wrong job|Malformed job/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Tracked ✓' })).toBeDisabled()
    expect(screen.queryByText(/couldn.t load this posting right now/i)).toBeNull()
  })

  it('distinguishes an offline initial load and retries with a read without duplicating the view event', async () => {
    const retryDetail = {
      ...BASE_DETAIL,
      capabilities: { ...BASE_DETAIL.capabilities, xray: false },
    }
    let detailCalls = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) {
        detailCalls += 1
        return detailCalls === 1 ? Promise.reject(new Error('offline')) : jsonResponse(retryDetail)
      }
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)

    expect(await screen.findByText('You appear to be offline.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('heading', { name: BASE_DETAIL.title })).toBeTruthy()
    expect(detailCalls).toBe(2)
    const viewEvents = mockFetch.mock.calls.filter(([url, init]) => (
      String(url) === '/api/events' && String(init?.body).includes('jobs.job_viewed')
    ))
    expect(viewEvents).toHaveLength(1)
  })

  it('reserves missing copy for an authoritative 404', async () => {
    mockFetch.mockImplementation((input: RequestInfo | URL) => (
      String(input) === `/api/jobs/${JOB_ID}`
        ? Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) })
        : jsonResponse({})
    ))

    render(<JobDetailPage params={{ id: JOB_ID }} />)

    expect(await screen.findByText(/isn.t available anymore/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('renders an authoritative 410 as closed rather than a temporary failure', async () => {
    mockFetch.mockImplementation((input: RequestInfo | URL) => (
      String(input) === `/api/jobs/${JOB_ID}`
        ? Promise.resolve({ ok: false, status: 410, json: () => Promise.resolve({}) })
        : jsonResponse({})
    ))

    render(<JobDetailPage params={{ id: JOB_ID }} />)

    expect(await screen.findByText('This posting has closed or expired.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('does not let a truthy X-ray role expose Practice when the server withholds readiness', async () => {
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/xray')) return jsonResponse(XRAY)
      if (url === `/api/jobs/${JOB_ID}`) return jsonResponse(BASE_DETAIL)
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)

    await screen.findByText('accessibility')
    await waitFor(() => {
      const detailCalls = mockFetch.mock.calls.filter(([url]) => String(url) === `/api/jobs/${JOB_ID}`)
      expect(detailCalls.length).toBeGreaterThanOrEqual(2)
    })
    expect(screen.queryByRole('button', { name: /Practice for this job/i })).toBeNull()
    expect(mockPush).not.toHaveBeenCalled()
  })

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace-only', '   '],
  ])('does not advertise or auto-start Practice when the canonical JD is %s', async (_case, jd) => {
    window.history.replaceState({}, '', `/jobs/${JOB_ID}?practice=1`)
    const noCanonicalJd = {
      ...BASE_DETAIL,
      capabilities: { ...BASE_DETAIL.capabilities, xray: false, practice: true },
      jd,
      practiceRole: 'frontend',
      practiceHandoffToken: 'server-signed-token',
      practiceExperience: '7+' as const,
    }
    mockFetch.mockImplementation((input: RequestInfo | URL) => (
      String(input) === `/api/jobs/${JOB_ID}` ? jsonResponse(noCanonicalJd) : jsonResponse({})
    ))

    render(<JobDetailPage params={{ id: JOB_ID }} />)

    expect(await screen.findByRole('heading', { name: BASE_DETAIL.title })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Practice for this job/i })).toBeNull()
    expect(localStorage.getItem(STORAGE_KEYS.INTERVIEW_CONFIG)).toBeNull()
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('blocks Practice on missing profile experience and links to Settings without guessing a range', async () => {
    window.history.replaceState({}, '', `/jobs/${JOB_ID}?practice=1`)
    const needsExperience = {
      ...BASE_DETAIL,
      capabilities: { ...BASE_DETAIL.capabilities, xray: false, practice: false },
      practiceBlocker: 'experience-required' as const,
    }
    mockFetch.mockImplementation((input: RequestInfo | URL) => (
      String(input) === `/api/jobs/${JOB_ID}` ? jsonResponse(needsExperience) : jsonResponse({})
    ))

    render(<JobDetailPage params={{ id: JOB_ID }} />)

    const settings = await screen.findByRole('link', { name: 'Settings' })
    expect(settings).toHaveAttribute('href', '/settings')
    expect(screen.getByText(/Add your experience level/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Practice for this job/i })).toBeNull()
    expect(localStorage.getItem(STORAGE_KEYS.INTERVIEW_CONFIG)).toBeNull()
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('waits for server readiness after X-ray persistence and uses the server role for email auto-start', async () => {
    window.history.replaceState({}, '', `/jobs/${JOB_ID}?practice=1`)
    const ready = {
      ...BASE_DETAIL,
      company: 'c'.repeat(201),
      practiceRole: 'frontend',
      practiceHandoffToken: 'server-signed-token',
      practiceExperience: '7+' as const,
    }
    let detailCalls = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/xray')) return jsonResponse(XRAY)
      if (url === `/api/jobs/${JOB_ID}`) {
        detailCalls += 1
        return jsonResponse(detailCalls === 1 ? BASE_DETAIL : ready)
      }
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/lobby'))
    expect(mockPush).toHaveBeenCalledTimes(1)
    const stored = JSON.parse(localStorage.getItem('interviewConfig') ?? '{}') as {
      role?: string
      experience?: string
      jobsHandoffToken?: string
      targetCompany?: string
    }
    expect(stored.role).toBe('frontend')
    expect(stored.experience).toBe('7+')
    expect(stored.jobsHandoffToken).toBe('server-signed-token')
    expect(stored.targetCompany).toHaveLength(200)
    expect(stored.role).not.toBe(XRAY.inferredDomain)
  })

  it('reconciles server readiness when the X-ray response is lost after persistence', async () => {
    const ready = {
      ...BASE_DETAIL,
      practiceRole: 'frontend',
      practiceHandoffToken: 'server-signed-token',
      practiceExperience: '7+' as const,
    }
    let detailCalls = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/xray')) return Promise.reject(new Error('response lost'))
      if (url === `/api/jobs/${JOB_ID}`) {
        detailCalls += 1
        return jsonResponse(detailCalls === 1 ? BASE_DETAIL : ready)
      }
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)

    expect(await screen.findByRole('button', { name: /Practice for this job/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(detailCalls).toBe(2)
  })

  it.each([
    ['lost transport', () => Promise.reject(new Error('response lost before persistence'))],
    ['gateway timeout', () => Promise.resolve({ ok: false, status: 504, json: () => Promise.resolve({}) })],
  ])('keeps polling after %s until delayed persistence enables auto-start', async (_case, xrayResponse) => {
    window.history.replaceState({}, '', `/jobs/${JOB_ID}?practice=1`)
    const ready = {
      ...BASE_DETAIL,
      practiceRole: 'frontend',
      practiceHandoffToken: 'server-signed-token',
      practiceExperience: '7+' as const,
    }
    let detailCalls = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/xray')) return xrayResponse()
      if (url === `/api/jobs/${JOB_ID}`) {
        detailCalls += 1
        return jsonResponse(detailCalls < 3 ? BASE_DETAIL : ready)
      }
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)

    await waitFor(
      () => expect(mockPush).toHaveBeenCalledWith('/lobby'),
      { timeout: 2_500 },
    )
    // initial load + two reconciliation reads + click-time authority refresh
    expect(detailCalls).toBe(4)
    expect(mockPush).toHaveBeenCalledTimes(1)
  })

  it('keeps X-ray reconciliation open until the server publishes a non-empty canonical JD', async () => {
    window.history.replaceState({}, '', `/jobs/${JOB_ID}?practice=1`)
    const credentialsWithoutJd = {
      ...BASE_DETAIL,
      jd: '   ',
      practiceRole: 'frontend',
      practiceHandoffToken: 'server-signed-token',
      practiceExperience: '7+' as const,
    }
    const ready = {
      ...credentialsWithoutJd,
      jd: 'Canonical persisted job description.',
    }
    let detailCalls = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/xray')) return Promise.reject(new Error('response lost before JD persistence'))
      if (url === `/api/jobs/${JOB_ID}`) {
        detailCalls += 1
        return jsonResponse(detailCalls < 3 ? credentialsWithoutJd : ready)
      }
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)

    await waitFor(
      () => expect(mockPush).toHaveBeenCalledWith('/lobby'),
      { timeout: 2_500 },
    )
    // Initial load + two reconciliation reads + click-time authority refresh.
    expect(detailCalls).toBe(4)
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.INTERVIEW_CONFIG) ?? '{}') as {
      jobDescription?: string
    }
    expect(stored.jobDescription).toBe(ready.jd)
  })

  it('does not refetch detail after X-ray when the initial server projection is already ready', async () => {
    const ready = {
      ...BASE_DETAIL,
      practiceRole: 'frontend',
      practiceHandoffToken: 'server-signed-token',
      practiceExperience: '7+' as const,
    }
    let detailCalls = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/xray')) return jsonResponse(XRAY)
      if (url === `/api/jobs/${JOB_ID}`) {
        detailCalls += 1
        return jsonResponse(ready)
      }
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)

    await screen.findByText('accessibility')
    expect(detailCalls).toBe(1)
    expect(screen.getByRole('button', { name: /Practice for this job/i })).toBeTruthy()
  })

  it('keeps an in-flight X-ray alive when Save replaces the detail projection', async () => {
    let releaseXray!: (response: { ok: boolean; json: () => Promise<typeof XRAY> }) => void
    const pendingXray = new Promise<{ ok: boolean; json: () => Promise<typeof XRAY> }>((resolve) => {
      releaseXray = resolve
    })
    let detailCalls = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/xray')) return pendingXray
      if (url.endsWith('/save')) return jsonResponse({ ok: true })
      if (url === `/api/jobs/${JOB_ID}`) {
        detailCalls += 1
        return jsonResponse(BASE_DETAIL)
      }
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
    await waitFor(() => expect(detailCalls).toBeGreaterThanOrEqual(2))
    releaseXray({ ok: true, json: () => Promise.resolve(XRAY) })

    expect(await screen.findByText('accessibility')).toBeTruthy()
    expect(screen.queryByText(/Reading the JD/i)).toBeNull()
  })

  it('presents a retryable parser fallback as a retry, not unsupported-role truth', async () => {
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/xray')) return jsonResponse({
        ...XRAY,
        keyThemes: [],
        requirements: [],
        retryable: true,
      })
      if (url === `/api/jobs/${JOB_ID}`) return jsonResponse(BASE_DETAIL)
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)

    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(screen.queryByText(/isn't available for this role yet/i)).toBeNull()
  })

  it('keeps stable X-ray evidence visible when only Practice role refresh is retryable', async () => {
    const preservedEvidence = {
      ...XRAY,
      retryable: true,
      requirements: [{
        id: 'req_stable',
        category: 'technical',
        requirement: 'Production React experience',
        importance: 'must-have' as const,
      }],
    }
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/xray')) return jsonResponse(preservedEvidence)
      if (url === `/api/jobs/${JOB_ID}`) return jsonResponse(BASE_DETAIL)
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)

    expect(await screen.findByText('Production React experience')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry practice setup' })).toBeTruthy()
    expect(screen.queryByText(/X-ray unavailable/i)).toBeNull()
  })

  it('fails visibly without navigation when click-time server readiness is revoked', async () => {
    const ready = {
      ...BASE_DETAIL,
      practiceRole: 'frontend',
      practiceHandoffToken: 'server-signed-token',
      practiceExperience: '7+' as const,
    }
    let detailCalls = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/xray')) return jsonResponse(XRAY)
      if (url === `/api/jobs/${JOB_ID}`) {
        detailCalls += 1
        return jsonResponse(detailCalls === 1 ? ready : BASE_DETAIL)
      }
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    fireEvent.click(await screen.findByRole('button', { name: /Practice for this job/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn\'t prepare/i)
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('fails closed when click-time reauthorization returns only whitespace as the JD', async () => {
    const ready = {
      ...BASE_DETAIL,
      capabilities: { ...BASE_DETAIL.capabilities, xray: false },
      practiceRole: 'frontend',
      practiceHandoffToken: 'server-signed-token',
      practiceExperience: '7+' as const,
    }
    let detailCalls = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) {
        detailCalls += 1
        return jsonResponse(detailCalls === 1 ? ready : { ...ready, jd: '   ' })
      }
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    fireEvent.click(await screen.findByRole('button', { name: /Practice for this job/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn\'t prepare/i)
    expect(localStorage.getItem(STORAGE_KEYS.INTERVIEW_CONFIG)).toBeNull()
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('replaces stale live content when click-time Practice reauthorization becomes restricted', async () => {
    const ready = {
      ...LIVE_APPLY_DETAIL,
      capabilities: { ...LIVE_APPLY_DETAIL.capabilities, practice: true },
      practiceRole: 'frontend',
      practiceHandoffToken: 'server-signed-token',
      practiceExperience: '7+' as const,
    }
    const restricted = {
      ...BASE_DETAIL,
      postingState: 'restricted' as const,
      capabilities: { apply: false, viewSource: false, xray: false, tailor: false, practice: false, atsCheck: false },
      jd: undefined,
      applyOptions: [],
      application: { applicationId: 'app1', status: 'saved', practiceCount: 0, ats: { state: 'none' as const } },
    }
    let detailCalls = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) {
        detailCalls += 1
        return jsonResponse(detailCalls === 1 ? ready : restricted)
      }
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    fireEvent.click(await screen.findByRole('button', { name: /Practice for this job/i }))

    expect(await screen.findByText('Posting unavailable')).toBeTruthy()
    expect(screen.queryByText(BASE_DETAIL.jd)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Apply ↗' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Tailor resume' })).toBeNull()
    expect(mockPush).not.toHaveBeenCalled()
  })

  it.each([
    ['a non-OK response', () => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) })],
    ['invalid JSON', () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new Error('invalid')) })],
    ['a malformed projection', () => jsonResponse({ id: JOB_ID })],
  ])('fails closed instead of retaining stale detail after click-time %s', async (_case, failedRefresh) => {
    const ready = {
      ...BASE_DETAIL,
      practiceRole: 'frontend',
      practiceHandoffToken: 'server-signed-token',
      practiceExperience: '7+' as const,
    }
    let detailCalls = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) {
        detailCalls += 1
        return detailCalls === 1 ? jsonResponse(ready) : failedRefresh()
      }
      if (url.endsWith('/xray')) return jsonResponse(XRAY)
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    fireEvent.click(await screen.findByRole('button', { name: /Practice for this job/i }))

    expect(await screen.findByText(/couldn.t load this posting right now/i)).toBeTruthy()
    expect(screen.queryByText(BASE_DETAIL.jd)).toBeNull()
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('offers a safe generic setup escape when a retake loses exact-job readiness', async () => {
    window.history.replaceState({}, '', `/jobs/${JOB_ID}?practice=1&retake=${RETAKE_ID}`)
    localStorage.setItem('pendingRetakeParent', RETAKE_ID)
    mockFetch.mockImplementation((input: RequestInfo | URL) => (
      String(input) === `/api/jobs/${JOB_ID}` ? jsonResponse(BASE_DETAIL) : jsonResponse({})
    ))

    render(<JobDetailPage params={{ id: JOB_ID }} />)

    const fallback = await screen.findByRole('link', { name: 'Start new general interview setup' })
    expect(fallback).toHaveAttribute(
      'href',
      '/interview/setup?jobsFallback=1',
    )
    fireEvent.click(fallback)
    expect(localStorage.getItem('pendingRetakeParent')).toBeNull()
  })

  it('renders an owner archive as closed preparation context and removes every apply surface', async () => {
    localStorage.setItem(`JOBS_RETURN_${JOB_ID}`, JSON.stringify({
      clickedAt: Date.now(), optionId: APPLY_OPTION_ID, url: 'https://stale.example/apply', tier: 'direct-ats',
    }))
    const archived = {
      ...BASE_DETAIL,
      postingState: 'archived' as const,
      capabilities: {
        apply: false,
        viewSource: false,
        xray: true,
        tailor: true,
        practice: true,
        atsCheck: true,
      },
      applyOptions: [{ optionId: APPLY_OPTION_ID, url: 'https://must-not-render.example/apply', tier: 'direct-ats' }],
      practiceRole: 'frontend',
      practiceHandoffToken: 'archived-owner-token',
      practiceExperience: '7+' as const,
      application: { applicationId: 'app1', status: 'applied', practiceCount: 1, ats: { state: 'none' as const } },
    }
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/xray')) return jsonResponse(XRAY)
      if (url === `/api/jobs/${JOB_ID}`) return jsonResponse(archived)
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)

    expect(await screen.findAllByText('Posting no longer active')).toHaveLength(2)
    expect(screen.getByRole('button', { name: /Practice for this job/i })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Tailor resume' })).toHaveAttribute('href', `/resume/tailor?jobId=${JOB_ID}`)
    expect(screen.getByRole('heading', { name: 'Saved job description' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Apply/i })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.queryByText(/View full posting/i)).toBeNull()
    expect(document.body.textContent).not.toContain('must-not-render.example')
    expect(document.body.textContent).not.toContain('Your application')
    await waitFor(() => expect(localStorage.getItem(`JOBS_RETURN_${JOB_ID}`)).toBeNull())
  })

  it('renders restricted history without fetching or exposing JD-derived actions', async () => {
    const restricted = {
      ...BASE_DETAIL,
      postingState: 'restricted' as const,
      capabilities: {
        apply: false,
        viewSource: false,
        xray: false,
        tailor: false,
        practice: false,
        atsCheck: false,
      },
      jd: undefined,
      application: {
        applicationId: 'app1',
        status: 'applied',
        practiceCount: 2,
        ats: { state: 'done' as const },
      },
    }
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return jsonResponse(restricted)
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)

    expect(await screen.findByText('Posting unavailable')).toBeTruthy()
    expect(screen.getByText(/removed by policy or closed before a safe archive reason was recorded/i)).toBeTruthy()
    expect(screen.getByText('The original job description is not available.')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Tailor resume' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Practice for this job/i })).toBeNull()
    expect(screen.getByText('ATS check completed before this posting became unavailable.')).toBeTruthy()
    expect(document.body.textContent).not.toContain('undefined/100')
    expect(document.body.textContent).not.toContain('Missing:')
    expect(mockFetch.mock.calls.some(([url]) => String(url).endsWith('/xray'))).toBe(false)
  })

  it('explains why an archive that closed before its first X-ray cannot generate one later', async () => {
    const archivedWithoutXray = {
      ...BASE_DETAIL,
      postingState: 'archived' as const,
      capabilities: {
        ...BASE_DETAIL.capabilities,
        xray: false,
      },
      application: {
        applicationId: 'app1',
        status: 'saved',
        practiceCount: 0,
        ats: { state: 'none' as const },
      },
    }
    mockFetch.mockImplementation((input: RequestInfo | URL) => (
      String(input) === `/api/jobs/${JOB_ID}` ? jsonResponse(archivedWithoutXray) : jsonResponse({})
    ))

    render(<JobDetailPage params={{ id: JOB_ID }} />)

    expect(await screen.findByText(/X-ray wasn.t saved while this job was live/i)).toBeTruthy()
    expect(screen.getByText(/can.t be generated after closure/i)).toBeTruthy()
    expect(mockFetch.mock.calls.some(([url]) => String(url).endsWith('/xray'))).toBe(false)
  })

  it('hides a live X-ray if the posting becomes restricted during reconciliation', async () => {
    const restricted = {
      ...BASE_DETAIL,
      postingState: 'restricted' as const,
      capabilities: {
        apply: false,
        viewSource: false,
        xray: false,
        tailor: false,
        practice: false,
        atsCheck: false,
      },
      jd: undefined,
      application: { applicationId: 'app1', status: 'saved', practiceCount: 0, ats: { state: 'none' as const } },
    }
    let detailCalls = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/xray')) return jsonResponse(XRAY)
      if (url === `/api/jobs/${JOB_ID}`) {
        detailCalls += 1
        return jsonResponse(detailCalls === 1 ? BASE_DETAIL : restricted)
      }
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)

    expect(await screen.findByText('Posting unavailable')).toBeTruthy()
    expect(screen.queryByText('accessibility')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it.each(['live', 'archived'] as const)(
    'uses general setup instead of a JD-built prep plan when a %s posting is not Practice-ready',
    async (postingState) => {
      const unready = {
        ...BASE_DETAIL,
        postingState,
        capabilities: {
          ...BASE_DETAIL.capabilities,
          xray: false,
          practice: false,
        },
        application: {
          applicationId: 'app1',
          status: 'interview_scheduled',
          interviewDate: '2099-07-25T10:00:00.000Z',
          interviewDateConfidence: 'exact' as const,
          practiceCount: 1,
          ats: { state: 'none' as const },
        },
      }
      mockFetch.mockImplementation((input: RequestInfo | URL) => (
        String(input) === `/api/jobs/${JOB_ID}` ? jsonResponse(unready) : jsonResponse({})
      ))

      render(<JobDetailPage params={{ id: JOB_ID }} />)

      expect(await screen.findByText('Interview status saved.')).toBeTruthy()
      expect(screen.getByText(/Interview date:/)).toBeTruthy()
      expect(screen.getByRole('link', { name: 'Open general interview setup' })).toHaveAttribute('href', '/interview/setup?jobsFallback=1')
      expect(screen.queryByText(/mocks built from this JD/i)).toBeNull()
      expect(screen.queryByText(/Let.s make sure you.re ready/i)).toBeNull()
      expect(screen.queryByRole('button', { name: 'Start' })).toBeNull()
      expect(mockFetch.mock.calls.some(([url]) => String(url).endsWith('/xray'))).toBe(false)
    },
  )

  it('keeps restricted interview history and date controls without claiming an absent date was saved', async () => {
    const restricted = {
      ...BASE_DETAIL,
      postingState: 'restricted' as const,
      capabilities: { apply: false, viewSource: false, xray: false, tailor: false, practice: false, atsCheck: false },
      jd: undefined,
      application: { applicationId: 'app1', status: 'interview_scheduled', practiceCount: 2, ats: { state: 'none' as const } },
    }
    mockFetch.mockImplementation((input: RequestInfo | URL) => (
      String(input) === `/api/jobs/${JOB_ID}` ? jsonResponse(restricted) : jsonResponse({})
    ))

    render(<JobDetailPage params={{ id: JOB_ID }} />)

    expect(await screen.findByText('Interview status saved.')).toBeTruthy()
    expect(screen.queryByText('Interview status and date saved.')).toBeNull()
    expect(screen.getByText('When is it?')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Tomorrow' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Not sure yet' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open general interview setup' })).toHaveAttribute('href', '/interview/setup?jobsFallback=1')
    expect(screen.queryByText(/Let.s make sure you.re ready/i)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Tomorrow' }))
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(
      `/api/jobs/${JOB_ID}/interview-date`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ choice: 'tomorrow' }),
      }),
    ))

    fireEvent.change(screen.getByLabelText('Exact interview date'), { target: { value: '2026-08-01' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save exact date' }))
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(
      `/api/jobs/${JOB_ID}/interview-date`,
      expect.objectContaining({ body: JSON.stringify({ date: '2026-08-01' }) }),
    ))
  })

  it('submits Apply through a native same-origin POST form and keeps View GET-only', async () => {
    mockFetch.mockImplementation((input: RequestInfo | URL) => (
      String(input) === `/api/jobs/${JOB_ID}` ? jsonResponse(LIVE_APPLY_DETAIL) : jsonResponse({})
    ))

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    const apply = await screen.findByRole('button', { name: 'Apply ↗' })
    const applyRedirectHref = `/api/jobs/${JOB_ID}/open?optionId=${APPLY_OPTION_ID}&intent=apply`
    const viewRedirectHref = `/api/jobs/${JOB_ID}/open?optionId=${APPLY_OPTION_ID}&intent=view`
    const applyForm = apply.closest('form')
    expect(applyForm).not.toBeNull()
    expect(applyForm).toHaveAttribute('action', applyRedirectHref)
    expect(applyForm).toHaveAttribute('method', 'post')
    expect(applyForm).toHaveAttribute('target', '_blank')
    expect(applyForm).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.getByRole('link', { name: /View full posting/i }))
      .toHaveAttribute('href', viewRedirectHref)
    fireEvent.click(apply)

    expect(window.open).toHaveBeenCalledTimes(1)
    expect(window.open).toHaveBeenCalledWith('', expect.stringMatching(/^[a-f0-9]{32}$/))
    const popup = vi.mocked(window.open).mock.results[0]?.value as Window
    const popupTarget = applyForm?.getAttribute('target')
    expect(popupTarget).toMatch(/^[a-f0-9]{32}$/)
    expect(popupTarget).not.toContain(JOB_ID)
    expect(popupTarget).not.toContain(APPLY_OPTION_ID)
    expect(popup.name).toBe(popupTarget)
    expect(popup.opener).toBeNull()
    expect(applyForm).not.toHaveAttribute('rel')
    const arm = JSON.parse(localStorage.getItem(`JOBS_RETURN_${JOB_ID}`) ?? '{}')
    expect(arm).toMatchObject({
      optionId: APPLY_OPTION_ID,
      url: 'https://apply.example/job',
      tier: 'direct-ats',
    })
    expect(mockFetch.mock.calls.some(([url]) => String(url).endsWith('/apply-click'))).toBe(false)

    fireEvent(document, new Event('visibilitychange'))
    fireEvent.click(await screen.findByRole('button', { name: /Link didn.t work/i }))
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(
      `/api/jobs/${JOB_ID}/broken-link`,
      expect.objectContaining({ body: JSON.stringify({ optionId: APPLY_OPTION_ID }) }),
    ))
  })

  it('keeps Apply and source actions available while every link is being verified', async () => {
    const allDemotedDetail = {
      ...LIVE_APPLY_DETAIL,
      allApplyOptionsDemoted: true,
    }
    mockFetch.mockImplementation((input: RequestInfo | URL) => (
      String(input) === `/api/jobs/${JOB_ID}` ? jsonResponse(allDemotedDetail) : jsonResponse({})
    ))

    render(<JobDetailPage params={{ id: JOB_ID }} />)

    expect(await screen.findByText('This link is being verified; it may still work.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Apply ↗' })).toBeEnabled()
    expect(screen.getByRole('link', { name: /View full posting/i })).toHaveAttribute(
      'href',
      `/api/jobs/${JOB_ID}/open?optionId=${APPLY_OPTION_ID}&intent=view`,
    )
    expect(screen.queryByText(/report count|reports|timestamp|machine-demoted|crowd-demoted/i)).toBeNull()
  })

  it('does not show verification copy while at least one clean option remains', async () => {
    mockFetch.mockImplementation((input: RequestInfo | URL) => (
      String(input) === `/api/jobs/${JOB_ID}`
        ? jsonResponse({ ...LIVE_APPLY_DETAIL_WITH_ALTERNATE, allApplyOptionsDemoted: false })
        : jsonResponse({})
    ))

    render(<JobDetailPage params={{ id: JOB_ID }} />)

    expect(await screen.findByRole('button', { name: 'Apply ↗' })).toBeEnabled()
    expect(screen.queryByText('This link is being verified; it may still work.')).toBeNull()
    const alternate = screen.getByRole('button', { name: 'Company careers' })
    expect(screen.getByText(/Also available:/i)).toBeTruthy()
    expect(alternate.closest('form')).toHaveAttribute(
      'action',
      `/api/jobs/${JOB_ID}/open?optionId=${ALTERNATE_OPTION_ID}&intent=apply`,
    )
    expect(alternate.closest('form')).toHaveAttribute('method', 'post')
    expect(alternate.closest('form')).toHaveAttribute('target', '_blank')
    expect(alternate.closest('form')).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('prevents Apply and leaves no false return arm when the browser blocks the popup', async () => {
    vi.mocked(window.open).mockReturnValueOnce(null)
    mockFetch.mockImplementation((input: RequestInfo | URL) => (
      String(input) === `/api/jobs/${JOB_ID}` ? jsonResponse(LIVE_APPLY_DETAIL) : jsonResponse({})
    ))

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    const apply = await screen.findByRole('button', { name: 'Apply ↗' })
    const form = apply.closest('form')
    const submitted = fireEvent.click(apply)

    expect(submitted).toBe(false)
    expect(await screen.findByRole('alert')).toHaveTextContent(/blocked the application tab/i)
    expect(localStorage.getItem(`JOBS_RETURN_${JOB_ID}`)).toBeNull()
    expect(form).toHaveAttribute('target', '_blank')
    expect(form).toHaveAttribute('rel', 'noopener noreferrer')
    expect(mockFetch.mock.calls.some(([url]) => String(url).endsWith('/apply-click'))).toBe(false)
  })

  it('renders no primary or alternate Apply forms when server capability is false', async () => {
    const contradictory = {
      ...LIVE_APPLY_DETAIL_WITH_ALTERNATE,
      capabilities: { ...LIVE_APPLY_DETAIL_WITH_ALTERNATE.capabilities, apply: false },
    }
    mockFetch.mockImplementation((input: RequestInfo | URL) => (
      String(input) === `/api/jobs/${JOB_ID}` ? jsonResponse(contradictory) : jsonResponse({})
    ))

    render(<JobDetailPage params={{ id: JOB_ID }} />)

    expect(await screen.findByRole('heading', { name: LIVE_APPLY_DETAIL.title })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Apply ↗' })).toBeNull()
    expect(screen.queryByText(/Also available:/i)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Company careers' })).toBeNull()
    expect(screen.queryByRole('link', { name: /View full posting/i })).toBeNull()
    expect(document.querySelector('form[action*="/open?"]')).toBeNull()
  })

  it('fails safely without opening or arming Apply when secure randomness is unavailable', async () => {
    const randomSpy = vi.spyOn(window.crypto, 'getRandomValues').mockImplementationOnce(() => {
      throw new Error('secure randomness unavailable')
    })
    mockFetch.mockImplementation((input: RequestInfo | URL) => (
      String(input) === `/api/jobs/${JOB_ID}` ? jsonResponse(LIVE_APPLY_DETAIL) : jsonResponse({})
    ))

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    const apply = await screen.findByRole('button', { name: 'Apply ↗' })
    const form = apply.closest('form')
    const submitted = fireEvent.click(apply)

    expect(submitted).toBe(false)
    expect(await screen.findByRole('alert')).toHaveTextContent(/open the application tab safely/i)
    expect(window.open).not.toHaveBeenCalled()
    expect(localStorage.getItem(`JOBS_RETURN_${JOB_ID}`)).toBeNull()
    expect(form).toHaveAttribute('target', '_blank')
    expect(form).toHaveAttribute('rel', 'noopener noreferrer')
    randomSpy.mockRestore()
  })

  it.each(['server error', 'transport error'])('does not let a slower visibility %s replace terminal account-unavailable state', async (failure) => {
    let resolveSave!: (value: unknown) => void
    let resolveVisibility!: (value: unknown) => void
    let rejectVisibility!: (reason: unknown) => void
    const saveResponse = new Promise((resolve) => { resolveSave = resolve })
    const visibilityResponse = new Promise((resolve, reject) => {
      resolveVisibility = resolve
      rejectVisibility = reject
    })
    let detailCalls = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) {
        detailCalls += 1
        return detailCalls === 1 ? jsonResponse(LIVE_APPLY_DETAIL) : visibilityResponse
      }
      if (url.endsWith('/save')) return saveResponse
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
    fireEvent(document, new Event('visibilitychange'))
    await waitFor(() => expect(detailCalls).toBe(2))

    await act(async () => {
      resolveSave({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ code: 'ACCOUNT_UNAVAILABLE' }),
      })
    })
    expect(await screen.findByText('Your account is unavailable.')).toBeTruthy()

    await act(async () => {
      if (failure === 'server error') {
        resolveVisibility({
          ok: false,
          status: 503,
          json: () => Promise.resolve({ error: 'temporarily unavailable' }),
        })
      } else {
        rejectVisibility(new Error('offline'))
      }
    })

    expect(screen.getByText('Your account is unavailable.')).toBeTruthy()
    expect(screen.queryByText(/couldn.t confirm this posting/i)).toBeNull()
    expect(screen.queryByRole('heading', { name: LIVE_APPLY_DETAIL.title })).toBeNull()
  })

  it('does not let a slower Practice refresh replace terminal account-unavailable state', async () => {
    let resolveSave!: (value: unknown) => void
    let resolvePractice!: (value: unknown) => void
    const saveResponse = new Promise((resolve) => { resolveSave = resolve })
    const practiceResponse = new Promise((resolve) => { resolvePractice = resolve })
    const practiceDetail = {
      ...LIVE_APPLY_DETAIL,
      capabilities: { ...LIVE_APPLY_DETAIL.capabilities, practice: true },
      practiceRole: 'frontend',
      practiceHandoffToken: 'server-signed-token',
      practiceExperience: '7+' as const,
    }
    let detailCalls = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) {
        detailCalls += 1
        return detailCalls === 1 ? jsonResponse(practiceDetail) : practiceResponse
      }
      if (url.endsWith('/save')) return saveResponse
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
    fireEvent.click(screen.getByRole('button', { name: /Practice for this job/i }))
    await waitFor(() => expect(detailCalls).toBe(2))

    await act(async () => {
      resolveSave({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ code: 'ACCOUNT_UNAVAILABLE' }),
      })
    })
    expect(await screen.findByText('Your account is unavailable.')).toBeTruthy()

    await act(async () => {
      resolvePractice({
        ok: false,
        status: 503,
        json: () => Promise.resolve({ error: 'temporarily unavailable' }),
      })
    })

    expect(screen.getByText('Your account is unavailable.')).toBeTruthy()
    expect(screen.queryByText(/couldn.t prepare this job practice/i)).toBeNull()
    expect(mockPush).not.toHaveBeenCalledWith('/lobby')
  })

  it('scrubs instead of showing generic return-sheet failure copy when a status mutation is account-unavailable', async () => {
    localStorage.setItem(`JOBS_RETURN_${JOB_ID}`, JSON.stringify({
      clickedAt: Date.now() - 21_000,
      optionId: APPLY_OPTION_ID,
      url: 'https://apply.example/job',
      tier: 'direct-ats',
    }))
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return jsonResponse(LIVE_APPLY_DETAIL)
      if (url.endsWith('/status')) return accountUnavailableResponse()
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    await screen.findByRole('button', { name: 'Apply ↗' })
    fireEvent(document, new Event('visibilitychange'))
    fireEvent.click(await screen.findByRole('button', { name: '✓ Yes, applied' }))

    expect(await screen.findByText('Your account is unavailable.')).toBeTruthy()
    expect(screen.queryByText(/Couldn.t record that just now/i)).toBeNull()
  })

  it('does not manufacture an application or retry when apply confirmation has no server row', async () => {
    localStorage.setItem(`JOBS_RETURN_${JOB_ID}`, JSON.stringify({
      clickedAt: Date.now() - 21_000,
      optionId: APPLY_OPTION_ID,
      url: 'https://apply.example/job',
      tier: 'direct-ats',
    }))
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return jsonResponse(LIVE_APPLY_DETAIL)
      if (url.endsWith('/status')) {
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) })
      }
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    await screen.findByRole('button', { name: 'Apply ↗' })
    fireEvent(document, new Event('visibilitychange'))
    fireEvent.click(await screen.findByRole('button', { name: '✓ Yes, applied' }))

    expect(await screen.findByRole('status')).toHaveTextContent(/Couldn.t record that just now/i)
    expect(mockFetch.mock.calls.filter(([url]) => String(url).endsWith('/status'))).toHaveLength(1)
    expect(mockFetch.mock.calls.some(([url]) => String(url).endsWith('/apply-click'))).toBe(false)
  })

  it('shows durable Tailor state and sends the explicit tailored version on apply confirmation', async () => {
    const tailoredAt = '2026-07-14T11:00:00.000Z'
    const tailoredDetail = {
      ...LIVE_APPLY_DETAIL,
      application: {
        applicationId: 'app-1',
        status: 'interview_scheduled',
        practiceCount: 0,
        tailoredResume: { createdAt: tailoredAt, current: true },
        appliedWith: { wasTailored: true },
        ats: { state: 'none' as const },
      },
    }
    localStorage.setItem(`JOBS_RETURN_${JOB_ID}`, JSON.stringify({
      clickedAt: Date.now() - 21_000,
      optionId: APPLY_OPTION_ID,
      url: 'https://apply.example/job',
      tier: 'direct-ats',
    }))
    let statusBody: Record<string, unknown> | null = null
    mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return jsonResponse(tailoredDetail)
      if (url.endsWith('/status')) {
        statusBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) })
      }
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)

    expect(await screen.findByText('Tailored resume saved for this job')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'View or update' })).toHaveAttribute(
      'href',
      `/resume/tailor?jobId=${JOB_ID}`,
    )
    expect(screen.getByText('This application used the tailored resume for this job.')).toBeTruthy()
    fireEvent(document, new Event('visibilitychange'))
    fireEvent.click(await screen.findByRole('button', { name: '✓ Yes, with tailored resume' }))

    await waitFor(() => expect(statusBody).toMatchObject({
      status: 'applied',
      appliedWith: { wasTailored: true, tailoredAt },
    }))
    expect(await screen.findByText(/Marked as applied/i)).toBeTruthy()
  })

  it('scrubs instead of showing stale-link fallback copy when broken-link reporting is account-unavailable', async () => {
    localStorage.setItem(`JOBS_RETURN_${JOB_ID}`, JSON.stringify({
      clickedAt: Date.now(),
      optionId: APPLY_OPTION_ID,
      url: 'https://apply.example/job',
      tier: 'direct-ats',
    }))
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return jsonResponse(LIVE_APPLY_DETAIL)
      if (url.endsWith('/broken-link')) return accountUnavailableResponse()
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    await screen.findByRole('button', { name: 'Apply ↗' })
    fireEvent(document, new Event('visibilitychange'))
    fireEvent.click(await screen.findByRole('button', { name: /Link didn.t work/i }))

    expect(await screen.findByText('Your account is unavailable.')).toBeTruthy()
    expect(screen.queryByText(/That link may be stale/i)).toBeNull()
  })

  it.each([
    ['pending-verification', /Thanks—we’re checking this link/i],
    ['crowd-demoted', /Several people reported this link, so we only moved it lower while we verify it/i],
    ['machine-demoted', /A recent check found this link unavailable/i],
  ] as const)('renders truthful %s broken-link copy and offers the current alternate', async (disposition, copy) => {
    localStorage.setItem(`JOBS_RETURN_${JOB_ID}`, JSON.stringify({
      clickedAt: Date.now(),
      optionId: APPLY_OPTION_ID,
      url: 'https://apply.example/job',
      tier: 'direct-ats',
    }))
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return jsonResponse(LIVE_APPLY_DETAIL_WITH_ALTERNATE)
      if (url.endsWith('/broken-link')) {
        return jsonResponse({ ok: true, disposition, alreadyReported: false })
      }
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    await screen.findByRole('button', { name: 'Apply ↗' })
    fireEvent(document, new Event('visibilitychange'))
    fireEvent.click(await screen.findByRole('button', { name: /Link didn.t work/i }))

    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent(copy)
    expect(status).toHaveTextContent('Try “Company careers” instead.')
    expect(status).not.toHaveTextContent(/three|3 reports|report count/i)
  })

  it.each([
    [404, /couldn’t verify this report against the current link and a recent Apply attempt, so nothing changed/i],
    [429, /Too many reports right now—please try again later/i],
    [503, /couldn’t submit that report just now/i],
  ] as const)('does not invent a global effect when broken-link reporting returns %i', async (statusCode, copy) => {
    localStorage.setItem(`JOBS_RETURN_${JOB_ID}`, JSON.stringify({
      clickedAt: Date.now(),
      optionId: APPLY_OPTION_ID,
      url: 'https://apply.example/job',
      tier: 'direct-ats',
    }))
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return jsonResponse(LIVE_APPLY_DETAIL_WITH_ALTERNATE)
      if (url.endsWith('/broken-link')) {
        return Promise.resolve({
          ok: false,
          status: statusCode,
          json: () => Promise.resolve({ error: 'not accepted' }),
        })
      }
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    await screen.findByRole('button', { name: 'Apply ↗' })
    fireEvent(document, new Event('visibilitychange'))
    fireEvent.click(await screen.findByRole('button', { name: /Link didn.t work/i }))

    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent(copy)
    expect(status).toHaveTextContent('Try “Company careers” instead.')
    expect(status).not.toHaveTextContent(/demoted for everyone|recent check found this link unavailable/i)
    const reports = mockFetch.mock.calls.filter(([url]) => String(url).endsWith('/broken-link'))
    expect(reports).toHaveLength(1)
  })

  it('clears legacy or cross-tab replaced return arms instead of authorizing a stale report sheet', async () => {
    localStorage.setItem(`JOBS_RETURN_${JOB_ID}`, JSON.stringify({
      clickedAt: Date.now(),
      url: 'https://apply.example/job',
      tier: 'direct-ats',
    }))
    mockFetch.mockImplementation((input: RequestInfo | URL) => (
      String(input) === `/api/jobs/${JOB_ID}` ? jsonResponse(LIVE_APPLY_DETAIL) : jsonResponse({})
    ))

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    await screen.findByRole('button', { name: 'Apply ↗' })
    fireEvent(document, new Event('visibilitychange'))

    await waitFor(() => expect(localStorage.getItem(`JOBS_RETURN_${JOB_ID}`)).toBeNull())
    expect(screen.queryByRole('dialog')).toBeNull()

    localStorage.setItem(`JOBS_RETURN_${JOB_ID}`, JSON.stringify({
      clickedAt: Date.now(),
      optionId: APPLY_OPTION_ID,
      url: 'https://replaced.example/apply',
      tier: 'direct-ats',
    }))
    fireEvent(document, new Event('visibilitychange'))
    await waitFor(() => expect(localStorage.getItem(`JOBS_RETURN_${JOB_ID}`)).toBeNull())
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('moves focus into the modal return sheet, contains Tab focus, and restores the Apply invoker on Escape', async () => {
    mockFetch.mockImplementation((input: RequestInfo | URL) => (
      String(input) === `/api/jobs/${JOB_ID}` ? jsonResponse(LIVE_APPLY_DETAIL) : jsonResponse({})
    ))

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    const apply = await screen.findByRole('button', { name: 'Apply ↗' })
    apply.focus()
    fireEvent.click(apply)
    fireEvent(document, new Event('visibilitychange'))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    const dialogButtons = within(dialog).getAllByRole('button')
    expect(dialogButtons[0]).toHaveFocus()

    dialogButtons[dialogButtons.length - 1].focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(dialogButtons[0]).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(dialogButtons[dialogButtons.length - 1]).toHaveFocus()

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(apply).toHaveFocus()
  })

  it('restores focus to the page heading when a persisted return sheet has no live Apply invoker', async () => {
    localStorage.setItem(`JOBS_RETURN_${JOB_ID}`, JSON.stringify({
      clickedAt: Date.now(),
      optionId: APPLY_OPTION_ID,
      url: 'https://apply.example/job',
      tier: 'direct-ats',
    }))
    mockFetch.mockImplementation((input: RequestInfo | URL) => (
      String(input) === `/api/jobs/${JOB_ID}` ? jsonResponse(LIVE_APPLY_DETAIL) : jsonResponse({})
    ))

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    const heading = await screen.findByRole('heading', { name: BASE_DETAIL.title })
    fireEvent(document, new Event('visibilitychange'))
    expect(await screen.findByRole('dialog')).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(heading).toHaveFocus()
  })

  it('announces return-sheet completion, restores focus after the action, and only offers truthful Tailor navigation', async () => {
    mockFetch.mockImplementation((input: RequestInfo | URL) => (
      String(input) === `/api/jobs/${JOB_ID}` ? jsonResponse(LIVE_APPLY_DETAIL) : jsonResponse({})
    ))

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    const apply = await screen.findByRole('button', { name: 'Apply ↗' })
    apply.focus()
    fireEvent.click(apply)
    fireEvent(document, new Event('visibilitychange'))
    fireEvent.click(await screen.findByRole('button', { name: 'It worked — still applying' }))

    const completion = await screen.findByRole('status')
    expect(completion).toHaveAttribute('aria-atomic', 'true')
    expect(apply).toHaveFocus()
    expect(within(completion).getByRole('link', { name: 'Open tailor' })).toHaveAttribute(
      'href',
      `/resume/tailor?jobId=${JOB_ID}`,
    )

    fireEvent.click(within(completion).getByRole('button', { name: 'Dismiss' }))
    expect(apply).toHaveFocus()
  })

  it('does not promise or link Tailor when the server capability is unavailable', async () => {
    const noTailor = {
      ...LIVE_APPLY_DETAIL,
      capabilities: { ...LIVE_APPLY_DETAIL.capabilities, tailor: false },
    }
    mockFetch.mockImplementation((input: RequestInfo | URL) => (
      String(input) === `/api/jobs/${JOB_ID}` ? jsonResponse(noTailor) : jsonResponse({})
    ))

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    const apply = await screen.findByRole('button', { name: 'Apply ↗' })
    fireEvent.click(apply)
    fireEvent(document, new Event('visibilitychange'))
    fireEvent.click(await screen.findByRole('button', { name: 'It worked — still applying' }))

    const completion = await screen.findByRole('status')
    expect(completion).toHaveTextContent(/keep this job tracked/i)
    expect(within(completion).queryByRole('link', { name: 'Open tailor' })).toBeNull()
  })

  it.each([
    ['a 404 response', () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }), /isn.t available anymore/i],
    ['a 410 response', () => Promise.resolve({ ok: false, status: 410, json: () => Promise.resolve({}) }), /closed or expired/i],
    ['a server response', () => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) }), /couldn.t load this posting right now/i],
    ['a malformed projection', () => jsonResponse({ id: JOB_ID }), /couldn.t load this posting right now/i],
    ['an offline response', () => Promise.reject(new Error('offline')), /appear to be offline/i],
    ['a gated projection', () => jsonResponse({ ...LIVE_APPLY_DETAIL, gated: true, jd: undefined, applyOptions: undefined }), /sign in to read the full posting/i],
  ])('fails closed on visibility revalidation with %s', async (_case, revalidation, safeCopy) => {
    let detailCalls = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      if (String(input) !== `/api/jobs/${JOB_ID}`) return jsonResponse({})
      detailCalls += 1
      return detailCalls === 1 ? jsonResponse(LIVE_APPLY_DETAIL) : revalidation()
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    const apply = await screen.findByRole('button', { name: 'Apply ↗' })
    fireEvent.click(apply)
    expect(localStorage.getItem(`JOBS_RETURN_${JOB_ID}`)).not.toBeNull()
    fireEvent(document, new Event('visibilitychange'))

    expect(await screen.findByText(safeCopy)).toBeTruthy()
    expect(localStorage.getItem(`JOBS_RETURN_${JOB_ID}`)).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Apply ↗' })).toBeNull()
    expect(screen.queryByText(BASE_DETAIL.jd)).toBeNull()
    await waitFor(() => {
      expect(apply.isConnected).toBe(false)
      expect(document.activeElement).not.toBe(document.body)
      expect(document.activeElement).not.toBe(apply)
    })
  })

  it('revalidates a continuously visible tab within four minutes and removes revoked controls', async () => {
    const restricted = {
      ...LIVE_APPLY_DETAIL,
      postingState: 'restricted' as const,
      capabilities: {
        apply: false,
        viewSource: false,
        xray: false,
        tailor: false,
        practice: false,
        atsCheck: false,
      },
      jd: undefined,
      applyOptions: [],
    }
    let intervalHandler: TimerHandler | null = null
    const setIntervalSpy = vi.spyOn(window, 'setInterval').mockImplementation((handler, delay) => {
      if (delay === 4 * 60_000) intervalHandler = handler
      return 42
    })
    let detailCalls = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      if (String(input) !== `/api/jobs/${JOB_ID}`) return jsonResponse({})
      detailCalls += 1
      return jsonResponse(detailCalls === 1 ? LIVE_APPLY_DETAIL : restricted)
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    expect(await screen.findByRole('button', { name: 'Apply ↗' })).toBeTruthy()
    expect(intervalHandler).not.toBeNull()

    await act(async () => {
      if (typeof intervalHandler === 'function') intervalHandler()
      await Promise.resolve()
    })

    expect(await screen.findByText('Posting unavailable')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Apply ↗' })).toBeNull()
    expect(screen.queryByRole('link', { name: /View full posting/i })).toBeNull()
    expect(detailCalls).toBe(2)
    setIntervalSpy.mockRestore()
  })

  it('clears a Tailor completion and restores its invoker if the posting becomes restricted', async () => {
    const restricted = {
      ...LIVE_APPLY_DETAIL,
      postingState: 'restricted' as const,
      gated: false,
      capabilities: {
        apply: false,
        viewSource: false,
        xray: false,
        tailor: false,
        practice: false,
        atsCheck: false,
      },
      jd: undefined,
      applyOptions: [],
    }
    let detailCalls = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      if (String(input) !== `/api/jobs/${JOB_ID}`) return jsonResponse({})
      detailCalls += 1
      return jsonResponse(detailCalls < 3 ? LIVE_APPLY_DETAIL : restricted)
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    const apply = await screen.findByRole('button', { name: 'Apply ↗' })
    fireEvent.click(apply)
    fireEvent(document, new Event('visibilitychange'))
    fireEvent.click(await screen.findByRole('button', { name: 'It worked — still applying' }))
    expect(await screen.findByRole('link', { name: 'Open tailor' })).toBeTruthy()

    fireEvent(document, new Event('visibilitychange'))

    expect(await screen.findByText('Posting unavailable')).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('link', { name: 'Open tailor' })).toBeNull()
    await waitFor(() => expect(screen.getByRole('heading', { name: BASE_DETAIL.title })).toHaveFocus())
  })
})
