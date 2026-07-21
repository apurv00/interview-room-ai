import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

const {
  mockRouter,
  mockFetchFeedbackSessionSummary,
  mockHasQueuedReplayUpload,
} = vi.hoisted(() => ({
  mockRouter: { push: vi.fn(), back: vi.fn(), replace: vi.fn() },
  mockFetchFeedbackSessionSummary: vi.fn(),
  mockHasQueuedReplayUpload: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useParams: () => ({ sessionId: '507f1f77bcf86cd799439011' }),
}))
vi.mock('next/dynamic', () => ({ default: () => () => null }))
vi.mock('@shared/ui/ScoreBar', () => ({ ScoreRing: () => <div data-testid="score-ring" /> }))
vi.mock('@feedback/components/AudioPlayer', () => ({ default: () => null }))
vi.mock('@feedback/components/OverviewTab', () => ({ default: () => null }))
vi.mock('@feedback/components/ScoresTab', () => ({ default: () => <div data-testid="scores-tab" /> }))
vi.mock('@learn/components/feedback/ShareButton', () => ({ default: () => null }))
vi.mock('@learn/components/pathway/PathwayPendingBanner', () => ({ default: () => null }))
vi.mock('@jobs/components/JobsCountLink', () => ({ default: () => null }))
vi.mock('@learn/hooks/usePathwayGenerationPoll', () => ({
  usePathwayGenerationPoll: () => ({ phase: 'idle', pollExhausted: false }),
}))
vi.mock('@feedback/lib/feedbackSessionFetcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@feedback/lib/feedbackSessionFetcher')>()
  return {
    ...actual,
    fetchFeedbackSessionSummary: (...args: unknown[]) => mockFetchFeedbackSessionSummary(...args),
  }
})
vi.mock('@interview/utils/resumableUpload', () => ({
  drainQueuedReplayUploads: vi.fn().mockResolvedValue(undefined),
  hasQueuedReplayUpload: (...args: unknown[]) => mockHasQueuedReplayUpload(...args),
}))
vi.mock('@shared/fetchWithRetry', () => ({ fetchWithRetry: vi.fn().mockResolvedValue(true) }))
vi.mock('@interview/utils/feedbackPrintHtml', () => ({ buildFeedbackPrintHtml: vi.fn(() => '') }))

import FeedbackPage from '../page'
import { FeedbackAccountUnavailableError } from '@feedback/lib/feedbackSessionFetcher'

const SESSION_ID = '507f1f77bcf86cd799439011'
const ROOT_ID = '507f1f77bcf86cd799439012'
const JOB_ID = '507f1f77bcf86cd799439013'

function storedSession(
  configOverrides: Record<string, unknown> = {},
  sessionOverrides: Record<string, unknown> = {},
) {
  return {
    _id: SESSION_ID,
    status: 'completed',
    completedAt: '2026-01-01T00:00:00.000Z',
    hasAnalysisSource: false,
    config: {
      role: 'backend',
      interviewType: 'behavioral',
      experience: '3-6',
      duration: 20,
      ...configOverrides,
    },
    resumeText: 'Candidate-owned resume',
    resumeFileName: 'resume.pdf',
    transcript: [],
    evaluations: [],
    speechMetrics: [],
    feedback: {
      overall_score: 75,
      pass_probability: 'High',
      confidence_level: 'High',
      red_flags: [],
      top_3_improvements: [],
      ideal_answers: [{ question: 'Q', ideal_answer: 'A' }],
      dimensions: {
        answer_quality: { score: 75, strengths: [], weaknesses: [] },
        communication: { score: 75, wpm: 120, filler_rate: 0, pause_score: 75, rambling_index: 0 },
        engagement_signals: {
          score: 75,
          engagement_score: 75,
          confidence_trend: 'stable',
          energy_consistency: 0.75,
          composure_under_pressure: 75,
        },
      },
    },
    ...sessionOverrides,
  }
}

function response(body: unknown, ok = true, status = ok ? 200 : 404) {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
  }
}

describe('feedback retake context', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    sessionStorage.clear()
    mockHasQueuedReplayUpload.mockResolvedValue(false)
  })

  it('sanitizes posting-derived context when a Jobs retake falls back to generic setup', async () => {
    mockFetchFeedbackSessionSummary.mockResolvedValue(storedSession({}, {
      jobDescription: 'Revoked canonical JD',
      jdFileName: 'revoked-role.pdf',
      attribution: { source: 'jobs', jobId: JOB_ID, applicationId: 'app-1' },
    }))
    localStorage.setItem('interviewConfig', JSON.stringify({
      jobDescription: 'Even older Jobs JD',
      attribution: { source: 'jobs', jobId: JOB_ID },
      jobsHandoffToken: 'older-token',
    }))
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/interviews/${SESSION_ID}?excludeTranscript=true`) {
        return response(storedSession({}, {
          jobDescription: 'Revoked canonical JD',
          jdFileName: 'revoked-role.pdf',
          attribution: { source: 'jobs', jobId: JOB_ID, applicationId: 'app-1' },
        }))
      }
      if (url.endsWith(`/api/interviews/${SESSION_ID}/retake`)) {
        return response({ parentSessionId: ROOT_ID, jobsOrigin: true })
      }
      return response(null, false)
    }))

    render(<FeedbackPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Retake this interview' }))

    await waitFor(() => {
      expect(mockRouter.push).toHaveBeenCalledWith('/interview/setup?jobsFallback=1')
    })
    expect(JSON.parse(localStorage.getItem('interviewConfig') || '{}')).toEqual({
      role: 'backend',
      interviewType: 'behavioral',
      experience: '3-6',
      duration: 20,
      resumeText: 'Candidate-owned resume',
      resumeFileName: 'resume.pdf',
    })
    expect(localStorage.getItem('pendingRetakeParent')).toBeNull()
  })

  it('preserves an ordinary retake\'s candidate-provided JD', async () => {
    mockFetchFeedbackSessionSummary.mockResolvedValue(storedSession({}, {
      jobDescription: 'Candidate-provided JD',
      jdFileName: 'my-role.pdf',
      resumeText: 'Candidate-owned resume',
      resumeFileName: 'resume.pdf',
    }))
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/interviews/${SESSION_ID}?excludeTranscript=true`) {
        return response(storedSession({}, {
          jobDescription: 'Candidate-provided JD',
          jdFileName: 'my-role.pdf',
          resumeText: 'Candidate-owned resume',
          resumeFileName: 'resume.pdf',
        }))
      }
      if (url.endsWith(`/api/interviews/${SESSION_ID}/retake`)) {
        return response({ parentSessionId: ROOT_ID })
      }
      return response(null, false)
    }))

    render(<FeedbackPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Retake this interview' }))

    await waitFor(() => {
      expect(mockRouter.push).toHaveBeenCalledWith(`/interview/setup?retake=${ROOT_ID}`)
    })
    expect(JSON.parse(localStorage.getItem('interviewConfig') || '{}')).toMatchObject({
      jobDescription: 'Candidate-provided JD',
      jdFileName: 'my-role.pdf',
      resumeText: 'Candidate-owned resume',
      resumeFileName: 'resume.pdf',
    })
    expect(localStorage.getItem('pendingRetakeParent')).toBe(ROOT_ID)
  })

  it('removes a rendered Jobs bridge and browser state when the account becomes unavailable', async () => {
    let resolveJob!: (value: unknown) => void
    const jobResponse = new Promise((resolve) => { resolveJob = resolve })
    const jobsSession = storedSession({ targetCompany: 'Private Company' }, {
      attribution: { source: 'jobs', jobId: JOB_ID, applicationId: 'app-1' },
    })
    mockFetchFeedbackSessionSummary.mockResolvedValue(jobsSession)
    localStorage.setItem('interviewConfig', JSON.stringify({ jobDescription: 'Private JD' }))
    localStorage.setItem('interviewData:other-session', JSON.stringify({ transcript: 'Private transcript' }))
    sessionStorage.setItem('JOBS_TARGET', JSON.stringify({ role: 'Private Role' }))
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/interviews/${SESSION_ID}?excludeTranscript=true`) {
        return Promise.resolve(response(jobsSession))
      }
      if (url === `/api/jobs/${JOB_ID}`) return jobResponse
      return Promise.resolve(response(null, false))
    }))

    render(<FeedbackPage />)

    expect(await screen.findByRole('link', { name: /Back to Private Company/i })).toBeTruthy()

    await act(async () => {
      resolveJob({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ code: 'ACCOUNT_UNAVAILABLE' }),
      })
    })

    await waitFor(() => {
      expect(screen.queryByRole('link', { name: /Back to Private Company/i })).toBeNull()
    })
    expect(screen.getByText('Your account is unavailable.')).toBeTruthy()
    expect(screen.getByText(/private interview feedback was cleared/i)).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Interview Feedback' })).toBeNull()
    expect(screen.queryByText('Private Company')).toBeNull()
    expect(localStorage.getItem('interviewConfig')).toBeNull()
    expect(localStorage.getItem('interviewData:other-session')).toBeNull()
    expect(sessionStorage.getItem('JOBS_TARGET')).toBeNull()
  })

  it('treats an exact primary-loader account signal as a terminal deletion fence', async () => {
    localStorage.setItem('interviewConfig', JSON.stringify({ jobDescription: 'Private JD' }))
    localStorage.setItem(`interviewData:${SESSION_ID}`, JSON.stringify({ transcript: 'Private transcript' }))
    sessionStorage.setItem(`feedback-session:${SESSION_ID}`, JSON.stringify({ private: true }))
    sessionStorage.setItem(`recording-url:v2:camera:${SESSION_ID}`, JSON.stringify({ private: true }))
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/interviews/${SESSION_ID}?excludeTranscript=true`) {
        return response({ code: 'ACCOUNT_UNAVAILABLE' }, false, 401)
      }
      return response(null, false)
    }))

    render(<FeedbackPage />)

    expect(await screen.findByText('Your account is unavailable.')).toBeTruthy()
    expect(screen.getByText(/private interview feedback was cleared/i)).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Interview Feedback' })).toBeNull()
    expect(localStorage.getItem('interviewConfig')).toBeNull()
    expect(localStorage.getItem(`interviewData:${SESSION_ID}`)).toBeNull()
    expect(sessionStorage.getItem(`feedback-session:${SESSION_ID}`)).toBeNull()
    expect(sessionStorage.getItem(`recording-url:v2:camera:${SESSION_ID}`)).toBeNull()
    expect(mockRouter.push).not.toHaveBeenCalled()
  })

  it('does not let a deferred recording presign repopulate caches after deletion', async () => {
    let resolvePresign!: (value: unknown) => void
    const presignResponse = new Promise((resolve) => { resolvePresign = resolve })
    const jobsSession = storedSession({ targetCompany: 'Private Company' }, {
      hasRecording: true,
      attribution: { source: 'jobs', jobId: JOB_ID, applicationId: 'app-1' },
    })
    localStorage.setItem('interviewConfig', JSON.stringify({ jobDescription: 'Private JD' }))
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/interviews/${SESSION_ID}?excludeTranscript=true`) {
        return Promise.resolve(response(jobsSession))
      }
      if (url === `/api/recordings/presign?sessionId=${SESSION_ID}&kind=camera`) {
        return presignResponse
      }
      if (url === `/api/jobs/${JOB_ID}`) {
        return Promise.resolve(response({ code: 'ACCOUNT_UNAVAILABLE' }, false, 401))
      }
      return Promise.resolve(response(null, false))
    }))

    render(<FeedbackPage />)

    expect(await screen.findByText('Your account is unavailable.')).toBeTruthy()
    await act(async () => {
      resolvePresign(response({
        url: 'https://private.example/recording.webm',
        expiresInSeconds: 900,
      }))
      await presignResponse
    })

    await waitFor(() => {
      expect(sessionStorage.getItem(`recording-url:v2:camera:${SESSION_ID}`)).toBeNull()
    })
    expect(localStorage.getItem('interviewConfig')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Interview Feedback' })).toBeNull()
  })

  it('terminally clears rendered feedback when a later shared poll sees exact account deletion', async () => {
    vi.useFakeTimers()
    try {
      const initialSession = storedSession()
      mockFetchFeedbackSessionSummary.mockRejectedValueOnce(
        new FeedbackAccountUnavailableError(),
      )
      localStorage.setItem('interviewConfig', JSON.stringify({ jobDescription: 'Private JD' }))
      localStorage.setItem('interviewData:other-session', JSON.stringify({ transcript: 'Private transcript' }))
      sessionStorage.setItem('feedback-session:other-session', JSON.stringify({ private: true }))
      sessionStorage.setItem(`recording-url:v2:camera:${SESSION_ID}`, JSON.stringify({ private: true }))
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === `/api/interviews/${SESSION_ID}?excludeTranscript=true`) {
          return response(initialSession)
        }
        return response(null, false)
      }))

      render(<FeedbackPage />)
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(screen.getByRole('heading', { name: 'Interview Feedback' })).toBeTruthy()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
      })

      expect(screen.getByText('Your account is unavailable.')).toBeTruthy()
      expect(screen.queryByRole('heading', { name: 'Interview Feedback' })).toBeNull()
      expect(localStorage.getItem('interviewConfig')).toBeNull()
      expect(localStorage.getItem('interviewData:other-session')).toBeNull()
      expect(sessionStorage.getItem('feedback-session:other-session')).toBeNull()
      expect(sessionStorage.getItem(`recording-url:v2:camera:${SESSION_ID}`)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('terminally clears rendered feedback when the enrichment poll sees exact account deletion', async () => {
    vi.useFakeTimers()
    try {
      const initialSession = storedSession({}, {
        enrichmentStatus: 'running',
        feedback: {
          ...storedSession().feedback,
          ideal_answers: [],
          drill_recommendations: [],
        },
      })
      let sessionSummaryRequests = 0
      mockFetchFeedbackSessionSummary.mockResolvedValue(null)
      localStorage.setItem('interviewConfig', JSON.stringify({ jobDescription: 'Private JD' }))
      sessionStorage.setItem('feedback-session:other-session', JSON.stringify({ private: true }))
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === `/api/interviews/${SESSION_ID}?excludeTranscript=true`) {
          sessionSummaryRequests += 1
          // Primary load + JobsBridge establish the initially rendered page.
          // A later direct enrichment refresh observes deletion in progress.
          if (sessionSummaryRequests > 2) {
            return response({ code: 'ACCOUNT_UNAVAILABLE' }, false, 401)
          }
          return response(initialSession)
        }
        return response(null, false)
      }))

      render(<FeedbackPage />)
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(screen.getByRole('heading', { name: 'Interview Feedback' })).toBeTruthy()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000)
      })

      expect(screen.getByText('Your account is unavailable.')).toBeTruthy()
      expect(screen.queryByRole('heading', { name: 'Interview Feedback' })).toBeNull()
      expect(localStorage.getItem('interviewConfig')).toBeNull()
      expect(sessionStorage.getItem('feedback-session:other-session')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
