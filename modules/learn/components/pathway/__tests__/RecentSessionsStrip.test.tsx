import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const { mockFetch, mockPush } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockPush: vi.fn(),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }))
vi.mock('framer-motion', () => ({
  motion: { section: ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => <section {...props}>{children}</section> },
}))

import RecentSessionsStrip from '../RecentSessionsStrip'

const SESSION_ID = '507f1f77bcf86cd799439011'
const ROOT_ID = '507f1f77bcf86cd799439012'

function response(body: unknown, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(body) })
}

function fullConfig(jobDescription: string) {
  return {
    role: 'backend',
    interviewType: 'behavioral',
    experience: '3-6',
    duration: 20,
    jobDescription,
    jdFileName: 'role.pdf',
    targetCompany: 'Revoked Co',
    targetIndustry: 'restricted-sector',
    resumeText: 'Candidate resume',
    attribution: { source: 'jobs', jobId: '507f1f77bcf86cd799439013' },
    jobsHandoffToken: 'consumed-token',
  }
}

beforeEach(() => {
  mockFetch.mockReset()
  mockPush.mockReset()
  localStorage.clear()
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('RecentSessionsStrip retake handoff', () => {
  it('scrubs restricted Jobs context before generic setup', async () => {
    localStorage.setItem('interviewConfig', JSON.stringify(fullConfig('OLDER STALE JD')))
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/interviews?limit=3&status=completed') {
        return response({ sessions: [{ _id: SESSION_ID, config: { role: 'backend' } }] })
      }
      if (url === `/api/interviews/${SESSION_ID}/retake`) {
        return response({
          parentSessionId: ROOT_ID,
          jobsOrigin: true,
          config: { role: 'backend', experience: '3-6', duration: 20 },
        })
      }
      if (url === `/api/interviews/${SESSION_ID}?excludeTranscript=true`) {
        return response({
          config: {
            role: 'backend',
            interviewType: 'behavioral',
            experience: '3-6',
            duration: 20,
          },
          jobDescription: 'REVOKED JD',
          jdFileName: 'role.pdf',
          resumeText: 'Candidate resume',
          resumeFileName: 'resume.pdf',
        })
      }
      return response({}, false)
    })

    render(<RecentSessionsStrip />)
    fireEvent.click(await screen.findByRole('button', { name: 'Retake' }))

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/interview/setup?jobsFallback=1'))
    expect(JSON.parse(localStorage.getItem('interviewConfig') || '{}')).toEqual({
      role: 'backend',
      interviewType: 'behavioral',
      experience: '3-6',
      duration: 20,
      resumeText: 'Candidate resume',
      resumeFileName: 'resume.pdf',
    })
    expect(localStorage.getItem('pendingRetakeParent')).toBeNull()
  })

  it('clears stale Jobs context when the full-session fetch fails', async () => {
    localStorage.setItem('interviewConfig', JSON.stringify(fullConfig('STALE JD')))
    localStorage.setItem('interviewConfig:user-1', JSON.stringify(fullConfig('SCOPED STALE JD')))
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/interviews?limit=3&status=completed') {
        return response({ sessions: [{ _id: SESSION_ID, config: { role: 'backend' } }] })
      }
      if (url === `/api/interviews/${SESSION_ID}/retake`) {
        return response({
          parentSessionId: ROOT_ID,
          jobsOrigin: true,
          config: { role: 'backend', experience: '3-6', duration: 20 },
        })
      }
      if (url === `/api/interviews/${SESSION_ID}?excludeTranscript=true`) throw new Error('offline')
      return response({}, false)
    })

    render(<RecentSessionsStrip />)
    fireEvent.click(await screen.findByRole('button', { name: 'Retake' }))

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/interview/setup?jobsFallback=1'))
    expect(JSON.parse(localStorage.getItem('interviewConfig') || '{}')).toEqual({
      role: 'backend',
      experience: '3-6',
      duration: 20,
    })
    expect(localStorage.getItem('pendingRetakeParent')).toBeNull()
  })

  it('preserves an ordinary retake JD', async () => {
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/interviews?limit=3&status=completed') {
        return response({ sessions: [{ _id: SESSION_ID, config: { role: 'backend' } }] })
      }
      if (url === `/api/interviews/${SESSION_ID}/retake`) {
        return response({ parentSessionId: ROOT_ID, config: { role: 'backend', experience: '3-6', duration: 20 } })
      }
      if (url === `/api/interviews/${SESSION_ID}?excludeTranscript=true`) {
        return response({
          config: {
            role: 'backend',
            interviewType: 'behavioral',
            experience: '3-6',
            duration: 20,
          },
          jobDescription: 'Candidate-provided JD',
          jdFileName: 'candidate-role.pdf',
          resumeText: 'Candidate resume',
          resumeFileName: 'candidate-resume.pdf',
        })
      }
      return response({}, false)
    })

    render(<RecentSessionsStrip />)
    fireEvent.click(await screen.findByRole('button', { name: 'Retake' }))

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(`/interview/setup?retake=${ROOT_ID}`))
    expect(JSON.parse(localStorage.getItem('interviewConfig') || '{}')).toMatchObject({
      jobDescription: 'Candidate-provided JD',
      jdFileName: 'candidate-role.pdf',
      resumeText: 'Candidate resume',
      resumeFileName: 'candidate-resume.pdf',
    })
    expect(localStorage.getItem('pendingRetakeParent')).toBe(ROOT_ID)
  })

  it('uses the URL fallback authority when browser writes fail', async () => {
    localStorage.setItem('interviewConfig:user-1', JSON.stringify(fullConfig('SCOPED STALE JD')))
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/interviews?limit=3&status=completed') {
        return response({ sessions: [{ _id: SESSION_ID, config: { role: 'backend' } }] })
      }
      if (url === `/api/interviews/${SESSION_ID}/retake`) {
        return response({
          parentSessionId: ROOT_ID,
          jobsOrigin: true,
          config: { role: 'backend', experience: '3-6', duration: 20 },
        })
      }
      if (url === `/api/interviews/${SESSION_ID}?excludeTranscript=true`) throw new Error('offline')
      return response({}, false)
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })

    render(<RecentSessionsStrip />)
    fireEvent.click(await screen.findByRole('button', { name: 'Retake' }))

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/interview/setup?jobsFallback=1'))
    expect(JSON.parse(localStorage.getItem('interviewConfig:user-1') || '{}')).toMatchObject({
      jobDescription: 'SCOPED STALE JD',
    })
    expect(localStorage.getItem('pendingRetakeParent')).toBeNull()
  })
})
