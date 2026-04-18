import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

const mockFindById = vi.fn()
const mockFindByIdAndUpdate = vi.fn()

vi.mock('@shared/db/models', () => ({
  InterviewSession: {
    findById: (...args: unknown[]) => mockFindById(...args),
    findByIdAndUpdate: (...args: unknown[]) => mockFindByIdAndUpdate(...args),
  },
  User: {},
}))

vi.mock('@shared/db/models/InterviewDepth', () => ({
  InterviewDepth: {},
}))

vi.mock('@shared/auth/permissions', () => ({
  canEditSession: vi.fn().mockReturnValue(true),
  canViewSession: vi.fn().mockReturnValue(true),
}))

vi.mock('@shared/db/seed', () => ({ FALLBACK_DEPTHS: [] }))
vi.mock('@shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('@interview/services/persona/jdParserService', () => ({
  parseJobDescription: vi.fn(),
  buildParsedJDContext: vi.fn(),
}))

vi.mock('@interview/services/persona/resumeContextService', () => ({
  parseAndCacheResume: vi.fn(),
  buildParsedResumeContext: vi.fn(),
}))

vi.mock('@interview/services/persona/documentContextCache', () => ({
  setCachedJDContext: vi.fn(),
  setCachedResumeContext: vi.fn(),
}))

vi.mock('@interview/services/core/sessionConfigCache', () => ({
  warmSessionConfigCache: vi.fn(),
}))

import { updateSession } from '@interview/services/core/interviewService'

describe('updateSession — recording artifact persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindById.mockResolvedValue({
      userId: { toString: () => 'user-1' },
      organizationId: undefined,
      status: 'in_progress',
    })
    mockFindByIdAndUpdate.mockResolvedValue({ _id: { toString: () => 'session-1' } })
  })

  it('persists audio, screen, live transcript, and completion artifact fields', async () => {
    await updateSession('session-1', 'user-1', 'candidate', undefined, {
      audioRecordingR2Key: 'recordings/user-1/session-1-audio.webm',
      audioRecordingSizeBytes: 12345,
      screenRecordingR2Key: 'recordings/user-1/session-1-screen.webm',
      screenRecordingSizeBytes: 67890,
      liveTranscriptWords: [{ word: 'hello', start: 0, end: 0.4, confidence: 0.99 }],
      answeredCount: 3,
      endReason: 'normal',
    })

    expect(mockFindByIdAndUpdate).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        audioRecordingR2Key: 'recordings/user-1/session-1-audio.webm',
        audioRecordingSizeBytes: 12345,
        screenRecordingR2Key: 'recordings/user-1/session-1-screen.webm',
        screenRecordingSizeBytes: 67890,
        liveTranscriptWords: [{ word: 'hello', start: 0, end: 0.4, confidence: 0.99 }],
        answeredCount: 3,
        endReason: 'normal',
      }),
      { returnDocument: 'after' }
    )
  })
})
