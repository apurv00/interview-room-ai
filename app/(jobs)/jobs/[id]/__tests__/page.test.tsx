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
const APPLY_OPTION_ID = `ao1_${'a'.repeat(43)}`
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
  vi.stubGlobal('open', vi.fn())
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
    ['a transport failure', () => Promise.reject(new Error('offline'))],
    ['an invalid response', () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new Error('invalid JSON')) })],
  ])('uses truthful unavailable copy for %s on initial load', async (_case, detailResponse) => {
    mockFetch.mockImplementation((input: RequestInfo | URL) => (
      String(input) === `/api/jobs/${JOB_ID}` ? detailResponse() : jsonResponse({})
    ))

    render(<JobDetailPage params={{ id: JOB_ID }} />)

    expect(await screen.findByText(/couldn.t confirm this posting is still available/i)).toBeTruthy()
    expect(screen.queryByText(/isn.t available anymore/i)).toBeNull()
  })

  it('reserves missing copy for an authoritative 404', async () => {
    mockFetch.mockImplementation((input: RequestInfo | URL) => (
      String(input) === `/api/jobs/${JOB_ID}`
        ? Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) })
        : jsonResponse({})
    ))

    render(<JobDetailPage params={{ id: JOB_ID }} />)

    expect(await screen.findByText(/isn.t available anymore/i)).toBeTruthy()
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

  it('waits for server readiness after X-ray persistence and uses the server role for email auto-start', async () => {
    window.history.replaceState({}, '', `/jobs/${JOB_ID}?practice=1`)
    const ready = {
      ...BASE_DETAIL,
      company: 'c'.repeat(201),
      practiceRole: 'frontend',
      practiceHandoffToken: 'server-signed-token',
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
      jobsHandoffToken?: string
      targetCompany?: string
    }
    expect(stored.role).toBe('frontend')
    expect(stored.jobsHandoffToken).toBe('server-signed-token')
    expect(stored.targetCompany).toHaveLength(200)
    expect(stored.role).not.toBe(XRAY.inferredDomain)
  })

  it('reconciles server readiness when the X-ray response is lost after persistence', async () => {
    const ready = {
      ...BASE_DETAIL,
      practiceRole: 'frontend',
      practiceHandoffToken: 'server-signed-token',
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

  it('does not refetch detail after X-ray when the initial server projection is already ready', async () => {
    const ready = {
      ...BASE_DETAIL,
      practiceRole: 'frontend',
      practiceHandoffToken: 'server-signed-token',
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

  it('replaces stale live content when click-time Practice reauthorization becomes restricted', async () => {
    const ready = {
      ...LIVE_APPLY_DETAIL,
      capabilities: { ...LIVE_APPLY_DETAIL.capabilities, practice: true },
      practiceRole: 'frontend',
      practiceHandoffToken: 'server-signed-token',
    }
    const restricted = {
      ...BASE_DETAIL,
      postingState: 'restricted' as const,
      capabilities: { apply: false, viewSource: false, xray: false, tailor: false, practice: false, atsCheck: false },
      jd: undefined,
      applyOptions: undefined,
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
  ])('fails closed instead of retaining stale detail after click-time %s', async (_case, failedRefresh) => {
    const ready = {
      ...BASE_DETAIL,
      practiceRole: 'frontend',
      practiceHandoffToken: 'server-signed-token',
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

    expect(await screen.findByText(/couldn.t confirm this posting is still available/i)).toBeTruthy()
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

  it('opens the displayed canonical URL but sends only its opaque optionId to mutation routes', async () => {
    mockFetch.mockImplementation((input: RequestInfo | URL) => (
      String(input) === `/api/jobs/${JOB_ID}` ? jsonResponse(LIVE_APPLY_DETAIL) : jsonResponse({})
    ))

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Apply ↗' }))

    expect(window.open).toHaveBeenCalledWith('https://apply.example/job', '_blank', 'noopener')
    const arm = JSON.parse(localStorage.getItem(`JOBS_RETURN_${JOB_ID}`) ?? '{}')
    expect(arm).toMatchObject({
      optionId: APPLY_OPTION_ID,
      url: 'https://apply.example/job',
      tier: 'direct-ats',
    })
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(
      `/api/jobs/${JOB_ID}/apply-click`,
      expect.objectContaining({ body: JSON.stringify({ optionId: APPLY_OPTION_ID }) }),
    ))

    fireEvent(document, new Event('visibilitychange'))
    fireEvent.click(await screen.findByRole('button', { name: /Link didn.t work/i }))
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(
      `/api/jobs/${JOB_ID}/broken-link`,
      expect.objectContaining({ body: JSON.stringify({ optionId: APPLY_OPTION_ID }) }),
    ))
  })

  it('scrubs the job when the Apply keepalive reports account unavailability', async () => {
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) return jsonResponse(LIVE_APPLY_DETAIL)
      if (url.endsWith('/apply-click')) return accountUnavailableResponse()
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Apply ↗' }))

    expect(await screen.findByText('Your account is unavailable.')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: LIVE_APPLY_DETAIL.title })).toBeNull()
    expect(localStorage.getItem(`JOBS_RETURN_${JOB_ID}`)).toBeNull()
  })

  it.each(['server error', 'transport error'])('does not let a slower visibility %s replace terminal account-unavailable state', async (failure) => {
    let resolveApply!: (value: unknown) => void
    let resolveVisibility!: (value: unknown) => void
    let rejectVisibility!: (reason: unknown) => void
    const applyResponse = new Promise((resolve) => { resolveApply = resolve })
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
      if (url.endsWith('/apply-click')) return applyResponse
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Apply ↗' }))
    fireEvent(document, new Event('visibilitychange'))
    await waitFor(() => expect(detailCalls).toBe(2))

    await act(async () => {
      resolveApply({
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
    let resolveApply!: (value: unknown) => void
    let resolvePractice!: (value: unknown) => void
    const applyResponse = new Promise((resolve) => { resolveApply = resolve })
    const practiceResponse = new Promise((resolve) => { resolvePractice = resolve })
    const practiceDetail = {
      ...LIVE_APPLY_DETAIL,
      capabilities: { ...LIVE_APPLY_DETAIL.capabilities, practice: true },
      practiceRole: 'frontend',
      practiceHandoffToken: 'server-signed-token',
    }
    let detailCalls = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/jobs/${JOB_ID}`) {
        detailCalls += 1
        return detailCalls === 1 ? jsonResponse(practiceDetail) : practiceResponse
      }
      if (url.endsWith('/apply-click')) return applyResponse
      return jsonResponse({})
    })

    render(<JobDetailPage params={{ id: JOB_ID }} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Apply ↗' }))
    fireEvent.click(screen.getByRole('button', { name: /Practice for this job/i }))
    await waitFor(() => expect(detailCalls).toBe(2))

    await act(async () => {
      resolveApply({
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

  it('clears legacy or replaced return arms instead of authorizing a stale report sheet', async () => {
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
    ['a non-OK response', () => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) }), /couldn.t confirm this posting/i],
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
      applyOptions: undefined,
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
