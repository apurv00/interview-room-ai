import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

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
vi.mock('@feedback/lib/feedbackSessionFetcher', () => ({
  fetchFeedbackSessionSummary: (...args: unknown[]) => mockFetchFeedbackSessionSummary(...args),
}))
vi.mock('@interview/utils/resumableUpload', () => ({
  drainQueuedReplayUploads: vi.fn().mockResolvedValue(undefined),
  hasQueuedReplayUpload: (...args: unknown[]) => mockHasQueuedReplayUpload(...args),
}))
vi.mock('@shared/fetchWithRetry', () => ({ fetchWithRetry: vi.fn().mockResolvedValue(true) }))
vi.mock('@interview/utils/feedbackPrintHtml', () => ({ buildFeedbackPrintHtml: vi.fn(() => '') }))

import FeedbackPage from '../page'

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

function response(body: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 404,
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
})
