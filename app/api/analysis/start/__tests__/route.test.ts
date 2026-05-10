import { NextRequest } from 'next/server'
import mongoose from 'mongoose'

const mocks = vi.hoisted(() => ({
  userId: '69fb49747e70dc410e5a2f12',
  sessionId: '69fb576edadf44259295721d',
  analysisId: '69fb576edadf44259295721e',
  connectDB: vi.fn(),
  isFeatureEnabled: vi.fn(),
  interviewFindOne: vi.fn(),
  analysisFindOne: vi.fn(),
  analysisDeleteOne: vi.fn(),
  analysisCountDocuments: vi.fn(),
  analysisCreate: vi.fn(),
  analysisFindOneAndUpdate: vi.fn(),
  enforceAnalysisCap: vi.fn(),
  inngestSend: vi.fn(),
}))

vi.mock('@shared/middleware/composeApiRoute', () => ({
  composeApiRoute: (opts: {
    schema?: { parse: (value: unknown) => unknown }
    handler: (
      req: NextRequest,
      ctx: {
        user: { id: string; role: string; plan: string; email: string }
        body: unknown
        params: Record<string, string>
      }
    ) => Promise<Response>
  }) => async (req: NextRequest) => {
    const raw = await req.json()
    const body = opts.schema ? opts.schema.parse(raw) : raw
    return opts.handler(req, {
      user: {
        id: mocks.userId,
        role: 'candidate',
        plan: 'free',
        email: 'candidate@example.com',
      },
      body,
      params: {},
    })
  },
}))

vi.mock('@shared/db/connection', () => ({
  connectDB: mocks.connectDB,
}))

vi.mock('@shared/db/models/InterviewSession', () => ({
  InterviewSession: {
    findOne: mocks.interviewFindOne,
  },
}))

vi.mock('@shared/db/models/MultimodalAnalysis', () => ({
  MultimodalAnalysis: {
    findOne: mocks.analysisFindOne,
    deleteOne: mocks.analysisDeleteOne,
    countDocuments: mocks.analysisCountDocuments,
    create: mocks.analysisCreate,
    findOneAndUpdate: mocks.analysisFindOneAndUpdate,
  },
}))

vi.mock('@shared/featureFlags', () => ({
  isFeatureEnabled: mocks.isFeatureEnabled,
}))

vi.mock('@shared/services/analysisCleanup', () => ({
  enforceAnalysisCap: mocks.enforceAnalysisCap,
}))

vi.mock('@shared/services/inngest', () => ({
  inngest: {
    send: mocks.inngestSend,
  },
}))

vi.mock('@shared/logger', () => ({
  aiLogger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}))

import { POST } from '../route'

function makeRequest(sessionId = mocks.sessionId): NextRequest {
  return new NextRequest('http://localhost/api/analysis/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  })
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    _id: mocks.sessionId,
    userId: mocks.userId,
    transcript: [
      {
        speaker: 'candidate',
        text: 'I handled a partial-information project by validating assumptions first.',
        timestamp: Date.now(),
      },
    ],
    liveTranscriptWords: [],
    recordingR2Key: undefined,
    audioRecordingR2Key: undefined,
    save: vi.fn(),
    ...overrides,
  }
}

describe('POST /api/analysis/start', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.INNGEST_EVENT_KEY = 'test-event-key'
    process.env.INNGEST_SIGNING_KEY = 'test-signing-key'
    mocks.isFeatureEnabled.mockReturnValue(true)
    mocks.analysisFindOne.mockResolvedValue(null)
    mocks.analysisDeleteOne.mockResolvedValue({})
    mocks.analysisCountDocuments.mockResolvedValue(0)
    mocks.analysisCreate.mockResolvedValue({
      _id: new mongoose.Types.ObjectId(mocks.analysisId),
    })
    mocks.inngestSend.mockResolvedValue(undefined)
  })

  afterEach(() => {
    delete process.env.INNGEST_EVENT_KEY
    delete process.env.INNGEST_SIGNING_KEY
  })

  it('starts analysis for a transcript-only session without waiting for replay recording upload', async () => {
    const session = makeSession()
    mocks.interviewFindOne.mockResolvedValue(session)

    const res = await POST(makeRequest())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      jobId: mocks.analysisId,
      status: 'pending',
    })
    expect(mocks.interviewFindOne).toHaveBeenCalledWith({
      _id: expect.any(mongoose.Types.ObjectId),
      userId: mocks.userId,
    })
    expect(mocks.analysisCreate).toHaveBeenCalledWith({
      sessionId: expect.any(mongoose.Types.ObjectId),
      userId: expect.any(mongoose.Types.ObjectId),
      status: 'pending',
    })
    expect((session as { multimodalAnalysisId?: mongoose.Types.ObjectId }).multimodalAnalysisId?.toString())
      .toBe(mocks.analysisId)
    expect(session.save).toHaveBeenCalled()
    expect(mocks.inngestSend).toHaveBeenCalledWith({
      name: 'analysis/requested',
      data: expect.objectContaining({
        sessionId: mocks.sessionId,
        userId: mocks.userId,
      }),
    })
  })

  it('does not create a doomed analysis job when only recording keys exist', async () => {
    mocks.interviewFindOne.mockResolvedValue(makeSession({
      transcript: [],
      liveTranscriptWords: [],
      recordingR2Key: 'recordings/session.webm',
      audioRecordingR2Key: 'audio/session.webm',
    }))

    const res = await POST(makeRequest())
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toBe('Session has no transcript or live words for analysis')
    expect(mocks.analysisCreate).not.toHaveBeenCalled()
    expect(mocks.inngestSend).not.toHaveBeenCalled()
  })

  it('rejects invalid session IDs before querying MongoDB', async () => {
    const res = await POST(makeRequest('not-a-valid-objectid'))
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toBe('Invalid session ID format')
    expect(mocks.connectDB).not.toHaveBeenCalled()
    expect(mocks.analysisFindOne).not.toHaveBeenCalled()
    expect(mocks.interviewFindOne).not.toHaveBeenCalled()
  })
})
