import mongoose from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HIRE_MULTIMODAL_ANALYSIS_POLICY_VERSION } from '@shared/contracts/hireMultimodalAnalysisBridge'

const mocks = vi.hoisted(() => {
  class CandidatePiiTombstoneError extends Error {}
  class RuntimeMediaStaleError extends Error {}
  return {
    CandidatePiiTombstoneError,
    RuntimeMediaStaleError,
    connect: vi.fn(),
    applicationFindOne: vi.fn(),
    roundFindOne: vi.fn(),
    attemptFindOne: vi.fn(),
    receiptFindOne: vi.fn(),
    privacyExists: vi.fn(),
    jobFindOne: vi.fn(),
    recognizedSnapshot: vi.fn(),
    supportsObservations: vi.fn(),
    fence: vi.fn(),
    ingestMedia: vi.fn(),
    activateMedia: vi.fn(),
    reserve: vi.fn(),
    complete: vi.fn(),
    release: vi.fn(),
    analysisFindOne: vi.fn(),
    analysisCreate: vi.fn(),
    eventFindOne: vi.fn(),
    eventCreate: vi.fn(),
    eventUpdateOne: vi.fn(),
    quarantineMedia: vi.fn(),
  }
})

vi.mock('@hire', () => ({
  HireApplication: { findOne: mocks.applicationFindOne },
  HireRound: { findOne: mocks.roundFindOne },
  HireInterviewAttempt: { findOne: mocks.attemptFindOne },
  HireConsentReceipt: { findOne: mocks.receiptFindOne },
  HirePrivacyRequest: { exists: mocks.privacyExists },
  HireJob: { findOne: mocks.jobFindOne },
  isRecognizedHireConsentSnapshot: mocks.recognizedSnapshot,
  supportsHireMultimodalObservations: mocks.supportsObservations,
  addCalendarMonths: vi.fn(),
  connectHireControlDB: mocks.connect,
  claimHireCandidatePiiWriteFence: mocks.fence,
  HireCandidatePiiTombstoneError: mocks.CandidatePiiTombstoneError,
  HireRuntimeMediaStaleError: mocks.RuntimeMediaStaleError,
  ingestRuntimeMediaArtifacts: mocks.ingestMedia,
  activateRuntimeMediaArtifacts: mocks.activateMedia,
  quarantineRuntimeMediaAssets: mocks.quarantineMedia,
  reserveHireRoundIngestion: mocks.reserve,
  completeHireRoundIngestion: mocks.complete,
  releaseHireRoundIngestion: mocks.release,
}))

vi.mock('../models', () => ({
  HireMultimodalAnalysis: {
    findOne: mocks.analysisFindOne,
    create: mocks.analysisCreate,
  },
  HireMultimodalAnalysisIngestionEvent: {
    findOne: mocks.eventFindOne,
    create: mocks.eventCreate,
    updateOne: mocks.eventUpdateOne,
  },
}))

import {
  HireMultimodalAnalysisIngestionError,
  ingestHireMultimodalAnalysis,
} from '../services/analysisIngestionService'

const IDS = {
  workspaceId: 'a'.repeat(24),
  applicationId: 'b'.repeat(24),
  roundId: 'c'.repeat(24),
  runtimeSessionId: 'd'.repeat(24),
  candidateId: 'e'.repeat(24),
  jobId: 'f'.repeat(24),
  attemptId: '1'.repeat(24),
  receiptId: '2'.repeat(24),
  resultId: '3'.repeat(24),
  assetId: '4'.repeat(24),
  analysisId: '5'.repeat(24),
}

function objectId(value: string) {
  return { toString: () => value }
}

function query<T>(value: T) {
  const chain = {
    select: vi.fn(),
    session: vi.fn(),
    sort: vi.fn(),
    lean: vi.fn().mockResolvedValue(value),
  }
  chain.select.mockReturnValue(chain)
  chain.session.mockReturnValue(chain)
  chain.sort.mockReturnValue(chain)
  return chain
}

function existsQuery<T>(value: T) {
  const promise = Promise.resolve(value)
  return {
    session: vi.fn().mockReturnThis(),
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
  }
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    eventId: '6'.repeat(64),
    workspaceId: IDS.workspaceId,
    applicationId: IDS.applicationId,
    roundId: IDS.roundId,
    runtimeSessionId: IDS.runtimeSessionId,
    attempt: 1,
    revision: 1,
    consentVersion: 'hire-ai-v6-2026-08-20',
    policyVersion: HIRE_MULTIMODAL_ANALYSIS_POLICY_VERSION,
    capturedAt: '2026-08-21T00:00:00.000Z',
    durationMs: 60_000,
    landmarks: {
      kind: 'landmarks',
      sourceKey: 'landmarks/private/raw.json',
      contentType: 'application/json',
      sizeBytes: 1_024,
      sha256: '7'.repeat(64),
    },
    transcript: [
      { speaker: 'candidate', text: 'Private answer', timestampMs: 1_000 },
    ],
    liveTranscriptWords: [],
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue(undefined)
  mocks.supportsObservations.mockReturnValue(true)
  mocks.recognizedSnapshot.mockReturnValue(true)
  mocks.applicationFindOne.mockReturnValue(
    query({
      candidateId: objectId(IDS.candidateId),
      jobId: objectId(IDS.jobId),
    }),
  )
  mocks.roundFindOne.mockReturnValue(
    query({
      consentVersion: 'hire-ai-v6-2026-08-20',
      resultId: objectId(IDS.resultId),
    }),
  )
  mocks.attemptFindOne.mockReturnValue(
    query({
      _id: objectId(IDS.attemptId),
      consentReceiptId: objectId(IDS.receiptId),
    }),
  )
  mocks.receiptFindOne.mockReturnValue(
    query({
      consentVersion: 'hire-ai-v6-2026-08-20',
      disclosureDigest: '8'.repeat(64),
    }),
  )
  mocks.privacyExists.mockReturnValue(existsQuery(null))
  mocks.jobFindOne.mockReturnValue(query({ status: 'open' }))
  mocks.fence.mockResolvedValue(undefined)
  mocks.ingestMedia.mockResolvedValue([
    { kind: 'facial_landmarks', _id: objectId(IDS.assetId) },
  ])
  mocks.activateMedia.mockResolvedValue(undefined)
  mocks.analysisCreate.mockResolvedValue([
    { _id: objectId(IDS.analysisId) },
  ])
  mocks.eventUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.complete.mockResolvedValue(undefined)
  mocks.release.mockResolvedValue(undefined)
  const session = {
    withTransaction: vi.fn(async (work: () => Promise<void>) => work()),
    endSession: vi.fn().mockResolvedValue(undefined),
  }
  vi.spyOn(mongoose, 'startSession').mockResolvedValue(session as never)
})

describe('multimodal analysis revision ordering', () => {
  it('returns stale for a delayed revision without copying or staging landmarks', async () => {
    mocks.reserve.mockResolvedValueOnce({ outcome: 'stale' })

    await expect(ingestHireMultimodalAnalysis(payload())).resolves.toEqual({
      outcome: 'stale',
    })
    expect(mocks.ingestMedia).not.toHaveBeenCalled()
    expect(mocks.analysisCreate).not.toHaveBeenCalled()
    expect(mocks.eventCreate).not.toHaveBeenCalled()
  })

  it('rejects a digest conflict without copying or staging landmarks', async () => {
    mocks.reserve.mockResolvedValueOnce({
      outcome: 'conflict',
      reason: 'The same analysis revision has different content',
    })

    await expect(
      ingestHireMultimodalAnalysis(payload()),
    ).rejects.toMatchObject<HireMultimodalAnalysisIngestionError>({
      code: 'conflict',
      status: 409,
    })
    expect(mocks.ingestMedia).not.toHaveBeenCalled()
    expect(mocks.analysisCreate).not.toHaveBeenCalled()
    expect(mocks.eventCreate).not.toHaveBeenCalled()
  })

  it('serializes a concurrent conflict before the loser reaches the media adapter', async () => {
    mocks.reserve
      .mockResolvedValueOnce({ outcome: 'acquired', reservationToken: 'owner' })
      .mockResolvedValueOnce({
        outcome: 'conflict',
        reason: 'The same analysis revision has different content',
      })
    let signalMediaStarted!: () => void
    const mediaStarted = new Promise<void>((resolve) => {
      signalMediaStarted = resolve
    })
    let releaseMedia!: () => void
    const mediaGate = new Promise<void>((resolve) => {
      releaseMedia = resolve
    })
    mocks.ingestMedia.mockImplementationOnce(async () => {
      signalMediaStarted()
      await mediaGate
      return [{ kind: 'facial_landmarks', _id: objectId(IDS.assetId) }]
    })

    const first = ingestHireMultimodalAnalysis(payload())
    await mediaStarted
    await expect(
      ingestHireMultimodalAnalysis(payload({ eventId: '9'.repeat(64) })),
    ).rejects.toMatchObject({ code: 'conflict', status: 409 })
    expect(mocks.ingestMedia).toHaveBeenCalledOnce()
    expect(mocks.analysisCreate).not.toHaveBeenCalled()
    releaseMedia()
    await expect(first).resolves.toEqual({
      outcome: 'processed',
      analysisId: IDS.analysisId,
    })
    expect(mocks.ingestMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        ingestionStream: 'multimodal_analysis',
        ingestionRevision: 1,
        ingestionEventId: '6'.repeat(64),
        ingestionDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    )
    expect(mocks.analysisCreate).toHaveBeenCalledOnce()
  })

  it('releases the exact durable reservation when media work fails', async () => {
    mocks.reserve.mockResolvedValueOnce({
      outcome: 'acquired',
      reservationToken: 'owner',
    })
    mocks.ingestMedia.mockRejectedValueOnce(new Error('copy failed'))

    await expect(ingestHireMultimodalAnalysis(payload())).rejects.toThrow(
      'copy failed',
    )
    expect(mocks.release).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: 'multimodalAnalysis',
        eventId: '6'.repeat(64),
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        reservationToken: 'owner',
      }),
    )
    expect(mocks.analysisCreate).not.toHaveBeenCalled()
  })

  it('quarantines a copied landmark in the same terminal-stale transaction', async () => {
    mocks.reserve.mockResolvedValueOnce({
      outcome: 'acquired',
      reservationToken: 'owner',
    })
    mocks.roundFindOne
      .mockReset()
      .mockReturnValueOnce(
        query({
          consentVersion: 'hire-ai-v6-2026-08-20',
          resultId: objectId(IDS.resultId),
        }),
      )
      .mockReturnValueOnce(
        query({
          consentVersion: 'hire-ai-v6-2026-08-20',
          resultId: undefined,
        }),
      )

    await expect(ingestHireMultimodalAnalysis(payload())).resolves.toEqual({
      outcome: 'stale',
    })
    expect(mocks.analysisCreate).not.toHaveBeenCalled()
    expect(mocks.quarantineMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        assets: [expect.objectContaining({ kind: 'facial_landmarks' })],
        workspaceId: IDS.workspaceId,
        applicationId: IDS.applicationId,
        jobId: IDS.jobId,
        candidateId: IDS.candidateId,
        roundId: IDS.roundId,
        attemptId: IDS.attemptId,
        reason: 'stale_staging',
        session: expect.anything(),
      }),
    )
    expect(mocks.complete).toHaveBeenCalledWith(
      expect.objectContaining({ terminalOutcome: 'stale' }),
    )
  })

  it('persists media lifecycle staleness instead of releasing the head', async () => {
    mocks.reserve.mockResolvedValueOnce({
      outcome: 'acquired',
      reservationToken: 'owner',
    })
    mocks.ingestMedia.mockRejectedValueOnce(
      new mocks.RuntimeMediaStaleError('retention expired'),
    )

    await expect(ingestHireMultimodalAnalysis(payload())).resolves.toEqual({
      outcome: 'stale',
    })
    expect(mocks.eventUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'received' }),
      expect.objectContaining({
        $set: expect.objectContaining({ terminalOutcome: 'stale' }),
      }),
      expect.objectContaining({ session: expect.anything() }),
    )
    expect(mocks.complete).toHaveBeenCalledWith(
      expect.objectContaining({ terminalOutcome: 'stale' }),
    )
    expect(mocks.release).not.toHaveBeenCalled()
  })
})
