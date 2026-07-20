import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const { mockFetch, mockPush } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockPush: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))
vi.mock('@shared/ui/AuthGateModal', () => ({ default: () => null }))

import JobDetailPage from '../page'

const JOB_ID = '507f1f77bcf86cd799439011'
const BASE_DETAIL = {
  id: JOB_ID,
  title: 'Frontend Engineer',
  company: 'Acme',
  locations: ['Remote'],
  isRemote: true,
  gated: false,
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

function jsonResponse(value: unknown, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(value) })
}

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch)
  mockFetch.mockReset()
  mockPush.mockReset()
  localStorage.clear()
  window.history.replaceState({}, '', `/jobs/${JOB_ID}`)
})

describe('Job detail Practice readiness', () => {
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
})
