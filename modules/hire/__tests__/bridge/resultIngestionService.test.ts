import { createHash } from 'node:crypto'
import mongoose from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HireEngineResultIngestion } from '@shared/contracts/hireEngineBridge'
import {
  HIRE_AI_CONSENT_VERSION,
  HIRE_AI_V5_CONSENT_VERSION,
} from '@hire-multimodal-boundary'

const mocks = vi.hoisted(() => {
  class CandidatePiiTombstoneError extends Error {}
  class RuntimeMediaStaleError extends Error {}
  return {
    CandidatePiiTombstoneError,
    RuntimeMediaStaleError,
    connect: vi.fn(),
    ingestionFindOne: vi.fn(),
    ingestionCreate: vi.fn(),
    ingestionUpdateOne: vi.fn(),
    applicationFindOne: vi.fn(),
    applicationUpdateOne: vi.fn(),
    roundFindOne: vi.fn(),
    roundUpdateOne: vi.fn(),
    attemptFindOne: vi.fn(),
    attemptUpdateOne: vi.fn(),
    privacyExists: vi.fn(),
    candidateFence: vi.fn(),
    ingestMedia: vi.fn(),
    activateMedia: vi.fn(),
    quarantineMedia: vi.fn(),
    assertResultCompatible: vi.fn(),
    persistResult: vi.fn(),
  }
})

vi.mock('../../services/hireControlBoundary', () => ({
  connectHireControlDB: mocks.connect,
}))
vi.mock('../../models/HireEngineIngestionEvent', () => ({
  HireEngineIngestionEvent: {
    findOne: mocks.ingestionFindOne,
    create: mocks.ingestionCreate,
    updateOne: mocks.ingestionUpdateOne,
  },
}))
vi.mock('../../models/HireApplication', () => ({
  HireApplication: {
    findOne: mocks.applicationFindOne,
    updateOne: mocks.applicationUpdateOne,
  },
}))
vi.mock('../../models/HireRound', () => ({
  HireRound: {
    findOne: mocks.roundFindOne,
    updateOne: mocks.roundUpdateOne,
  },
}))
vi.mock('../../models/HireInterviewAttempt', () => ({
  HireInterviewAttempt: {
    findOne: mocks.attemptFindOne,
    updateOne: mocks.attemptUpdateOne,
  },
}))
vi.mock('../../models/HirePrivacyRequest', () => ({
  HirePrivacyRequest: { exists: mocks.privacyExists },
}))
vi.mock('../../services/runtimeMediaIngestionService', () => ({
  HireRuntimeMediaStaleError: mocks.RuntimeMediaStaleError,
  ingestRuntimeMediaArtifacts: mocks.ingestMedia,
  activateRuntimeMediaArtifacts: mocks.activateMedia,
  quarantineRuntimeMediaAssets: mocks.quarantineMedia,
}))
vi.mock('../../services/hireCandidatePrivacyWriteFence', () => ({
  claimHireCandidatePiiWriteFence: mocks.candidateFence,
  HireCandidatePiiTombstoneError: mocks.CandidatePiiTombstoneError,
}))
vi.mock('../../services/evidenceService', () => ({
  assertHireInterviewResultCompatible: mocks.assertResultCompatible,
  persistHireInterviewResult: mocks.persistResult,
}))

import {
  __resultIngestion,
  HireEngineIngestionError,
  ingestHireEngineResult,
} from '../../services/resultIngestionService'

const IDS = {
  workspaceId: 'a'.repeat(24),
  applicationId: 'b'.repeat(24),
  roundId: 'c'.repeat(24),
  runtimeSessionId: 'd'.repeat(24),
  candidateId: '1'.repeat(24),
  jobId: '2'.repeat(24),
  attemptId: '3'.repeat(24),
  resultId: '4'.repeat(24),
  mediaAssetId: '5'.repeat(24),
}

const RUNTIME_PRINCIPAL_ID = createHash('sha256')
  .update(`ipg-hire-runtime-principal:v1:${IDS.roundId}`)
  .digest('hex')
  .slice(0, 24)

const MEDIA_ARTIFACT: HireEngineResultIngestion['media'][number] = {
  kind: 'recording',
  sourceKey: `recordings/${RUNTIME_PRINCIPAL_ID}/${IDS.runtimeSessionId}-1723248000000.webm`,
  contentType: 'video/webm',
  sizeBytes: 1_024,
  sha256: '7'.repeat(64),
}

const SCREEN_MEDIA_ARTIFACT: HireEngineResultIngestion['media'][number] = {
  kind: 'screen',
  sourceKey: `recordings/${RUNTIME_PRINCIPAL_ID}/${IDS.runtimeSessionId}-screen-1723248000000.webm`,
  contentType: 'video/webm',
  sizeBytes: 2_048,
  sha256: '8'.repeat(64),
}

function objectId(value: string) {
  return { toString: () => value }
}

function query(value: unknown) {
  const chain = {
    select: vi.fn(),
    session: vi.fn(),
    lean: vi.fn().mockResolvedValue(value),
    sort: vi.fn(),
  }
  chain.select.mockReturnValue(chain)
  chain.session.mockReturnValue(chain)
  chain.sort.mockReturnValue(chain)
  return chain
}

function payload(
  overrides: Partial<Omit<HireEngineResultIngestion, 'resultDigest'>> = {},
): HireEngineResultIngestion {
  const draft: Omit<HireEngineResultIngestion, 'resultDigest'> = {
    schemaVersion: 1,
    eventId: 'e'.repeat(64),
    workspaceId: IDS.workspaceId,
    applicationId: IDS.applicationId,
    roundId: IDS.roundId,
    runtimeSessionId: IDS.runtimeSessionId,
    attempt: 1,
    revision: 2,
    status: 'completed',
    startedAt: '2026-08-09T23:59:00.000Z',
    completedAt: '2026-08-10T00:00:00.000Z',
    durationMs: 60_000,
    results: {
      overallScore: 82,
      answerQualityScore: 84,
      communicationScore: 80,
      jdMatchScore: 81,
      passProbability: 'Advance',
      confidenceLevel: 'High',
      redFlags: [],
      topImprovements: ['Add more measurable outcomes'],
      answeredCount: 1,
      plannedQuestionCount: 1,
      perQuestion: [
        {
          questionIndex: 0,
          question: 'Tell me about a difficult launch.',
          answer: 'I led the launch and reduced failures by 40%.',
          score: 82,
          relevance: 85,
          structure: 80,
          specificity: 84,
          ownership: 79,
        },
      ],
      pending: false,
    },
    transcript: [
      {
        speaker: 'interviewer',
        text: 'Tell me about a difficult launch.',
        timestampMs: 1_000,
        questionIndex: 0,
      },
      {
        speaker: 'candidate',
        text: 'I led the launch and reduced failures by 40%.',
        timestampMs: 10_000,
        questionIndex: 0,
      },
      {
        speaker: 'interviewer',
        text: 'Thank you.',
        timestampMs: 45_000,
        questionIndex: 1,
      },
    ],
    media: [MEDIA_ARTIFACT],
    ...overrides,
  }
  return {
    ...draft,
    resultDigest: __resultIngestion.resultDigest(draft),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue(undefined)
  const fakeSession = {
    withTransaction: vi.fn(async (fn: () => Promise<void>) => fn()),
    endSession: vi.fn().mockResolvedValue(undefined),
  }
  vi.spyOn(mongoose, 'startSession').mockResolvedValue(fakeSession as never)
  mocks.ingestionFindOne
    .mockReturnValueOnce(query(null))
    .mockReturnValueOnce(query(null))
  mocks.applicationFindOne.mockReturnValue(
    query({
      candidateId: objectId(IDS.candidateId),
      jobId: objectId(IDS.jobId),
    }),
  )
  mocks.roundFindOne.mockReturnValue(
    query({
      candidateId: objectId(IDS.candidateId),
      jobId: objectId(IDS.jobId),
      revokedAt: undefined,
      runtimeSessionId: undefined,
    }),
  )
  mocks.attemptFindOne.mockReturnValue(
    query({ _id: objectId(IDS.attemptId), sequence: 1, status: 'processing' }),
  )
  mocks.attemptUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.privacyExists.mockResolvedValue(null)
  mocks.candidateFence.mockResolvedValue(undefined)
  mocks.assertResultCompatible.mockResolvedValue(undefined)
  mocks.ingestMedia.mockResolvedValue([
    { kind: 'camera_recording', _id: objectId(IDS.mediaAssetId) },
  ])
  mocks.activateMedia.mockResolvedValue(undefined)
  mocks.quarantineMedia.mockResolvedValue(undefined)
  mocks.persistResult.mockResolvedValue({ _id: objectId(IDS.resultId) })
  mocks.ingestionCreate.mockResolvedValue([{}])
  mocks.roundUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.applicationUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.ingestionUpdateOne.mockResolvedValue({ matchedCount: 1 })
})

describe('isolated engine result ingestion', () => {
  it('acknowledges but never persists PII/media behind a verified privacy tombstone', async () => {
    mocks.privacyExists.mockResolvedValueOnce({ _id: 'privacy-request' })
    const mediaCompletion = {
      contractVersion: 1 as const,
      camera: { status: 'published' as const },
      screen: { status: 'not_required' as const },
    }
    const input = payload({ mediaCompletion })

    await expect(ingestHireEngineResult(input)).resolves.toEqual({
      outcome: 'processed',
    })

    expect(mocks.ingestMedia).not.toHaveBeenCalled()
    expect(mocks.persistResult).not.toHaveBeenCalled()
    expect(mocks.ingestionCreate.mock.calls[0][0][0]).toMatchObject({
      eventId: input.eventId,
      resultDigest: input.resultDigest,
      media: [],
      mediaCompletion,
      status: 'received',
    })
    expect(mocks.roundUpdateOne).toHaveBeenCalledTimes(2)
    expect(mocks.roundUpdateOne.mock.calls[1][1]).toMatchObject({
      $set: {
        'ingestionReservations.engineResult.status': 'processed',
        runtimeSessionId: expect.any(mongoose.Types.ObjectId),
      },
      $unset: { live: 1 },
    })
    expect(mocks.attemptUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: IDS.attemptId,
        workspaceId: IDS.workspaceId,
        applicationId: IDS.applicationId,
        roundId: IDS.roundId,
      }),
      { $set: { status: 'revoked' }, $unset: { live: 1 } },
      { session: expect.anything() },
    )
  })

  it('discards copied media/result content when verified deletion wins the final fence', async () => {
    const input = payload()
    mocks.ingestionFindOne.mockReset().mockReturnValue(query(null))
    mocks.activateMedia.mockRejectedValueOnce(
      new mocks.CandidatePiiTombstoneError('privacy won'),
    )

    await expect(ingestHireEngineResult(input)).resolves.toEqual({
      outcome: 'processed',
    })

    expect(mocks.ingestMedia).toHaveBeenCalledOnce()
    expect(mocks.persistResult).toHaveBeenCalledOnce()
    expect(mocks.activateMedia).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: IDS.workspaceId,
      candidateId: IDS.candidateId,
      session: expect.anything(),
    }))
    expect(mocks.ingestionCreate).toHaveBeenCalledOnce()
    expect(mocks.ingestionCreate.mock.calls[0][0][0]).toMatchObject({
      eventId: input.eventId,
      resultDigest: input.resultDigest,
      media: [],
      status: 'received',
    })
    expect(mocks.roundUpdateOne).toHaveBeenCalledTimes(2)
    expect(mocks.roundUpdateOne.mock.calls[1][1]).toMatchObject({
      $set: {
        'ingestionReservations.engineResult.status': 'processed',
        runtimeSessionId: expect.any(mongoose.Types.ObjectId),
      },
      $unset: { live: 1 },
    })
    expect(mocks.applicationUpdateOne).not.toHaveBeenCalled()
  })

  it('validates every Hire coordinate and projects timestamped transcript/media evidence', async () => {
    const input = payload()
    await expect(ingestHireEngineResult(input)).resolves.toEqual({
      outcome: 'processed',
    })

    expect(mocks.applicationFindOne).toHaveBeenCalledWith({
      _id: IDS.applicationId,
      workspaceId: IDS.workspaceId,
    })
    expect(mocks.roundFindOne).toHaveBeenCalledWith({
      _id: IDS.roundId,
      workspaceId: IDS.workspaceId,
      applicationId: IDS.applicationId,
      candidateId: expect.anything(),
      jobId: expect.anything(),
    })
    expect(mocks.attemptFindOne).toHaveBeenCalledWith({
      workspaceId: IDS.workspaceId,
      applicationId: IDS.applicationId,
      jobId: expect.anything(),
      candidateId: expect.anything(),
      roundId: IDS.roundId,
      sequence: 1,
    })
    expect(mocks.ingestMedia).toHaveBeenCalledWith({
      workspaceId: IDS.workspaceId,
      applicationId: IDS.applicationId,
      jobId: IDS.jobId,
      candidateId: IDS.candidateId,
      roundId: IDS.roundId,
      attemptId: IDS.attemptId,
      runtimeSessionId: IDS.runtimeSessionId,
      ingestionStream: 'engine_result',
      ingestionAttempt: input.attempt,
      ingestionRevision: input.revision,
      ingestionEventId: input.eventId,
      ingestionDigest: input.resultDigest,
      completedAt: new Date(input.completedAt),
      artifacts: [MEDIA_ARTIFACT],
    })

    const persisted = mocks.persistResult.mock.calls[0][0]
    expect(persisted).toMatchObject({
      workspaceId: IDS.workspaceId,
      applicationId: IDS.applicationId,
      jobId: IDS.jobId,
      candidateId: IDS.candidateId,
      roundId: IDS.roundId,
      attemptId: IDS.attemptId,
      durationMs: 60_000,
      rawEngineOutput: {
        startedAt: input.startedAt,
        completedAt: input.completedAt,
        durationMs: input.durationMs,
        transcript: input.transcript,
      },
    })
    expect(persisted.projection.questions[0]).toMatchObject({
      questionId: 'q-0',
      questionStartedMs: 1_000,
      answerStartedMs: 10_000,
      answerEndedMs: 45_000,
      evidenceIds: ['q-0-answer', 'q-0-recording'],
    })
    expect(persisted.projection.overallEvidenceIds).toEqual([
      'q-0-answer',
      'q-0-recording',
    ])
    expect(persisted.evidenceIndex).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'q-0-answer',
          type: 'transcript_span',
          attemptId: IDS.attemptId,
          transcriptStart: 0,
          transcriptEnd: 1,
          transcriptExcerpt:
            'Interviewer: Tell me about a difficult launch.\nCandidate: I led the launch and reduced failures by 40%.',
          startMs: 10_000,
          endMs: 45_000,
        }),
        expect.objectContaining({
          id: 'q-0-recording',
          type: 'recording_range',
          attemptId: IDS.attemptId,
          mediaAssetId: IDS.mediaAssetId,
          startMs: 10_000,
          endMs: 45_000,
        }),
      ]),
    )

    const roundUpdateFilter = mocks.roundUpdateOne.mock.calls[1][0]
    expect(roundUpdateFilter).toMatchObject({
      _id: IDS.roundId,
      workspaceId: IDS.workspaceId,
      applicationId: IDS.applicationId,
    })
    expect(mocks.roundUpdateOne.mock.calls[1][1].$set).toMatchObject({
      resultId: expect.objectContaining({ toString: expect.any(Function) }),
      attemptCount: 1,
      status: 'completed',
    })
    expect(
      mocks.applicationUpdateOne.mock.calls[0][1].$push.events,
    ).toMatchObject({
      type: 'ai_result_linked',
      actorName: 'System',
    })
  })

  it('preserves a job-close revocation that wins before final terminalization', async () => {
    mocks.roundFindOne
      .mockReset()
      .mockReturnValueOnce(query({
        candidateId: objectId(IDS.candidateId),
        jobId: objectId(IDS.jobId),
        runtimeSessionId: undefined,
      }))
      .mockReturnValueOnce(query({
        candidateId: objectId(IDS.candidateId),
        jobId: objectId(IDS.jobId),
        runtimeSessionId: undefined,
        status: 'revoked',
        revokedAt: new Date('2026-08-10T00:00:01.000Z'),
      }))

    await expect(ingestHireEngineResult(payload())).resolves.toEqual({
      outcome: 'processed',
    })

    expect(mocks.activateMedia).toHaveBeenCalledOnce()
    expect(mocks.attemptUpdateOne).toHaveBeenLastCalledWith(
      expect.objectContaining({
        resultId: expect.anything(),
        status: { $in: ['completed', 'revoked'] },
      }),
      expect.objectContaining({
        $set: expect.not.objectContaining({ status: 'completed' }),
      }),
      expect.objectContaining({ session: expect.anything() }),
    )
    const terminalRoundUpdate = mocks.roundUpdateOne.mock.calls.at(-1)?.[1]
    expect(terminalRoundUpdate.$set).toMatchObject({
      'ingestionReservations.engineResult.status': 'processed',
      results: expect.objectContaining({ completedAfterRevoke: true }),
    })
    expect(terminalRoundUpdate.$set).not.toHaveProperty('status')
  })

  it('rejects display media for a V5 consent receipt before copying any artifact', async () => {
    mocks.roundFindOne.mockReturnValueOnce(
      query({
        candidateId: objectId(IDS.candidateId),
        jobId: objectId(IDS.jobId),
        consentVersion: HIRE_AI_V5_CONSENT_VERSION,
        revokedAt: undefined,
        runtimeSessionId: undefined,
      }),
    )

    await expect(
      ingestHireEngineResult(payload({ media: [SCREEN_MEDIA_ARTIFACT] })),
    ).rejects.toMatchObject<HireEngineIngestionError>({
      code: 'conflict',
      status: 409,
    })
    expect(mocks.ingestMedia).not.toHaveBeenCalled()
    expect(mocks.persistResult).not.toHaveBeenCalled()
  })

  it('accepts display media for the exact V6 consent receipt', async () => {
    mocks.roundFindOne.mockReturnValueOnce(
      query({
        candidateId: objectId(IDS.candidateId),
        jobId: objectId(IDS.jobId),
        consentVersion: HIRE_AI_CONSENT_VERSION,
        revokedAt: undefined,
        runtimeSessionId: undefined,
      }),
    )
    const input = payload({ media: [SCREEN_MEDIA_ARTIFACT] })

    await expect(ingestHireEngineResult(input)).resolves.toEqual({
      outcome: 'processed',
    })
    expect(mocks.ingestMedia).toHaveBeenCalledWith(
      expect.objectContaining({ artifacts: [SCREEN_MEDIA_ARTIFACT] }),
    )
  })

  it('acknowledges an identical processed event without mutating the round twice', async () => {
    const input = payload()
    mocks.ingestionFindOne.mockReset().mockReturnValue(
      query({
        eventId: input.eventId,
        workspaceId: objectId(IDS.workspaceId),
        applicationId: objectId(IDS.applicationId),
        resultDigest: input.resultDigest,
        roundId: objectId(IDS.roundId),
        runtimeSessionId: objectId(IDS.runtimeSessionId),
        revision: input.revision,
        attempt: input.attempt,
        status: 'processed',
      }),
    )

    await expect(ingestHireEngineResult(input)).resolves.toEqual({
      outcome: 'duplicate',
    })
    expect(mocks.ingestionCreate).not.toHaveBeenCalled()
    // The attempted atomic head advance and legacy-event lookup share one
    // transaction; the duplicate decision rolls that write back.
    expect(mocks.roundUpdateOne).toHaveBeenCalledOnce()
    expect(mocks.ingestMedia).not.toHaveBeenCalled()
    expect(mocks.persistResult).not.toHaveBeenCalled()
    expect(mocks.applicationUpdateOne).not.toHaveBeenCalled()
  })

  it('returns terminal stale again after the first acknowledgement was lost', async () => {
    const input = payload()
    mocks.ingestionFindOne.mockReset().mockReturnValue(
      query({
        eventId: input.eventId,
        workspaceId: objectId(IDS.workspaceId),
        applicationId: objectId(IDS.applicationId),
        resultDigest: input.resultDigest,
        roundId: objectId(IDS.roundId),
        runtimeSessionId: objectId(IDS.runtimeSessionId),
        revision: input.revision,
        attempt: input.attempt,
        status: 'processed',
        terminalOutcome: 'stale',
      }),
    )

    await expect(ingestHireEngineResult(input)).resolves.toEqual({
      outcome: 'stale',
    })
    expect(mocks.ingestMedia).not.toHaveBeenCalled()
    expect(mocks.persistResult).not.toHaveBeenCalled()
  })

  it('terminally records lifecycle-stale media activation', async () => {
    mocks.activateMedia.mockRejectedValueOnce(
      new mocks.RuntimeMediaStaleError('retention expired'),
    )

    await expect(ingestHireEngineResult(payload())).resolves.toEqual({
      outcome: 'stale',
    })
    expect(mocks.ingestionUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'received' }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'processed',
          terminalOutcome: 'stale',
        }),
      }),
      expect.objectContaining({ session: expect.anything() }),
    )
    expect(mocks.persistResult).toHaveBeenCalledOnce()
    expect(mocks.quarantineMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'stale_staging',
        assets: [expect.objectContaining({ kind: 'camera_recording' })],
      }),
    )
  })

  it('rejects a delayed older revision before any media or result mutation', async () => {
    mocks.roundFindOne
      .mockReset()
      .mockReturnValueOnce(
        query({
          candidateId: objectId(IDS.candidateId),
          jobId: objectId(IDS.jobId),
          runtimeSessionId: objectId(IDS.runtimeSessionId),
        }),
      )
      .mockReturnValue(
        query({
          runtimeSessionId: objectId(IDS.runtimeSessionId),
          ingestionReservations: {
            engineResult: {
              runtimeSessionId: objectId(IDS.runtimeSessionId),
              attempt: 1,
              revision: 3,
              eventId: '1'.repeat(64),
              digest: '2'.repeat(64),
              status: 'processed',
            },
          },
        }),
      )
    mocks.roundUpdateOne.mockResolvedValue({ matchedCount: 0 })

    await expect(ingestHireEngineResult(payload())).resolves.toEqual({
      outcome: 'stale',
    })
    expect(mocks.ingestMedia).not.toHaveBeenCalled()
    expect(mocks.persistResult).not.toHaveBeenCalled()
    expect(mocks.ingestionCreate).not.toHaveBeenCalled()
  })

  it('rejects a same-revision digest conflict before any media or result mutation', async () => {
    mocks.roundFindOne
      .mockReset()
      .mockReturnValueOnce(
        query({
          candidateId: objectId(IDS.candidateId),
          jobId: objectId(IDS.jobId),
          runtimeSessionId: objectId(IDS.runtimeSessionId),
        }),
      )
      .mockReturnValue(
        query({
          runtimeSessionId: objectId(IDS.runtimeSessionId),
          ingestionReservations: {
            engineResult: {
              runtimeSessionId: objectId(IDS.runtimeSessionId),
              attempt: 1,
              revision: 2,
              eventId: '1'.repeat(64),
              digest: '2'.repeat(64),
              status: 'processed',
            },
          },
        }),
      )
    mocks.roundUpdateOne.mockResolvedValue({ matchedCount: 0 })

    await expect(ingestHireEngineResult(payload())).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
    })
    expect(mocks.ingestMedia).not.toHaveBeenCalled()
    expect(mocks.persistResult).not.toHaveBeenCalled()
    expect(mocks.ingestionCreate).not.toHaveBeenCalled()
  })

  it('rejects a higher-revision immutable result conflict before copying media', async () => {
    const input = payload({
      revision: 3,
      eventId: '9'.repeat(64),
      results: {
        ...payload().results,
        overallScore: 13,
      },
    })
    mocks.assertResultCompatible.mockRejectedValueOnce(
      new Error('Interview result conflicts with the immutable prior result'),
    )

    await expect(ingestHireEngineResult(input)).rejects.toThrow(
      /conflicts with the immutable prior result/,
    )
    expect(mocks.assertResultCompatible).toHaveBeenCalledOnce()
    expect(mocks.ingestMedia).not.toHaveBeenCalled()
    expect(mocks.persistResult).not.toHaveBeenCalled()
  })

  it('serializes concurrent same-revision conflicts before the loser touches storage', async () => {
    const baseRound = {
      candidateId: objectId(IDS.candidateId),
      jobId: objectId(IDS.jobId),
      runtimeSessionId: undefined,
    }
    let head: Record<string, unknown> | undefined
    mocks.roundFindOne.mockImplementation((filter: Record<string, unknown>) =>
      'candidateId' in filter
        ? query(baseRound)
        : query({
            runtimeSessionId: objectId(IDS.runtimeSessionId),
            ingestionReservations: { engineResult: head },
          }),
    )
    mocks.roundUpdateOne.mockImplementation(
      async (
        _filter: unknown,
        update: { $set?: Record<string, unknown> },
      ) => {
        const reservation = update.$set?.[
          'ingestionReservations.engineResult'
        ] as Record<string, unknown> | undefined
        if (reservation) {
          if (head) return { matchedCount: 0 }
          head = reservation
          return { matchedCount: 1 }
        }
        if (
          update.$set?.['ingestionReservations.engineResult.status'] ===
          'processed'
        ) {
          head = { ...head, status: 'processed' }
        }
        return { matchedCount: 1 }
      },
    )
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
      return [{ kind: 'camera_recording', _id: objectId(IDS.mediaAssetId) }]
    })
    const firstInput = payload()
    const conflictingInput = payload({
      eventId: 'f'.repeat(64),
      results: { ...firstInput.results, overallScore: 81 },
    })

    const first = ingestHireEngineResult(firstInput)
    await mediaStarted
    expect(mocks.ingestMedia).toHaveBeenCalledOnce()
    await expect(
      ingestHireEngineResult(conflictingInput),
    ).rejects.toMatchObject({ code: 'conflict', status: 409 })
    // Only the accepted owner reached the media adapter. The conflicting
    // request performed no R2 copy, asset stage, or immutable result write.
    expect(mocks.ingestMedia).toHaveBeenCalledOnce()
    expect(mocks.persistResult).not.toHaveBeenCalled()
    releaseMedia()
    await expect(first).resolves.toEqual({ outcome: 'processed' })
    expect(mocks.persistResult).toHaveBeenCalledOnce()
  })

  it('accepts a camera-only higher revision from the same runtime session after the scorecard', async () => {
    const input = payload({
      eventId: 'f'.repeat(64),
      revision: 2,
      media: [MEDIA_ARTIFACT],
    })
    mocks.ingestionFindOne.mockReset()
    // The new event id has not been processed; revision 1 was already
    // accepted for this exact runtime session without a camera artifact.
    mocks.ingestionFindOne
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(
        query({
          runtimeSessionId: objectId(IDS.runtimeSessionId),
          revision: 1,
          resultDigest: '1'.repeat(64),
          status: 'processed',
        }),
      )

    await expect(ingestHireEngineResult(input)).resolves.toEqual({
      outcome: 'processed',
    })

    expect(mocks.ingestMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeSessionId: IDS.runtimeSessionId,
        ingestionStream: 'engine_result',
        ingestionRevision: input.revision,
        ingestionEventId: input.eventId,
        ingestionDigest: input.resultDigest,
        artifacts: [MEDIA_ARTIFACT],
      }),
    )
    // The evidence service returns the immutable revision-1 assessment when
    // raw scoring/transcript data is unchanged; the new event exists solely
    // to make the control-side camera asset available for the full player.
    expect(mocks.persistResult).toHaveBeenCalledOnce()
    expect(mocks.ingestionCreate.mock.calls[0][0][0]).toMatchObject({
      eventId: input.eventId,
      revision: 2,
      media: [],
      status: 'received',
    })
    const [terminalFilter] = mocks.ingestionUpdateOne.mock.calls.find(
      ([, update]) => update.$set?.terminalOutcome === 'processed',
    ) ?? []
    expect(terminalFilter).toMatchObject({
      eventId: input.eventId,
      runtimeSessionId: input.runtimeSessionId,
      attempt: input.attempt,
      revision: input.revision,
      resultDigest: input.resultDigest,
      status: 'received',
    })
    expect(terminalFilter).not.toHaveProperty('media')
    expect(terminalFilter).not.toHaveProperty('mediaCompletion')
  })

  it('persists a versioned terminal media state on a status-only revision', async () => {
    const mediaCompletion = {
      contractVersion: 1 as const,
      camera: { status: 'unavailable' as const, reason: 'retry_exhausted' as const },
      screen: { status: 'not_required' as const },
    }
    const input = payload({
      eventId: '9'.repeat(64),
      revision: 3,
      media: [],
      mediaCompletion,
    })
    const withoutCompletion = payload({
      eventId: input.eventId,
      revision: input.revision,
      media: [],
    })
    expect(input.resultDigest).not.toBe(withoutCompletion.resultDigest)
    mocks.ingestionFindOne.mockReset()
    mocks.ingestionFindOne
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query({
        runtimeSessionId: objectId(IDS.runtimeSessionId),
        attempt: 1,
        revision: 2,
        resultDigest: '1'.repeat(64),
        status: 'processed',
        terminalOutcome: 'processed',
      }))
    mocks.ingestMedia.mockResolvedValueOnce([])

    await expect(ingestHireEngineResult(input)).resolves.toEqual({
      outcome: 'processed',
    })

    expect(mocks.ingestionCreate.mock.calls[0][0][0]).toMatchObject({
      eventId: input.eventId,
      revision: 3,
      media: [],
      mediaCompletion,
      status: 'received',
    })
    expect(mocks.ingestionFindOne).toHaveBeenNthCalledWith(2, {
      workspaceId: IDS.workspaceId,
      applicationId: IDS.applicationId,
      roundId: IDS.roundId,
      status: { $in: ['received', 'processed'] },
    })
    expect(mocks.ingestionUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: input.eventId,
        status: 'received',
      }),
      {
        $set: {
          status: 'processed',
          terminalOutcome: 'processed',
          processedAt: expect.any(Date),
        },
      },
      { session: expect.anything() },
    )
  })

  it('fails closed when scored output has no timestamped candidate evidence', async () => {
    const input = payload({ transcript: [] })
    await expect(
      ingestHireEngineResult(input),
    ).rejects.toMatchObject<HireEngineIngestionError>({
      code: 'evidence_missing',
      status: 409,
    })
    expect(mocks.persistResult).not.toHaveBeenCalled()
    expect(mocks.roundUpdateOne).not.toHaveBeenCalled()
  })

  it('links dimensions and Q-referenced findings only to their producing transcript moments', () => {
    const input = payload({
      results: {
        overallScore: 78,
        answerQualityScore: 80,
        communicationScore: 76,
        jdMatchScore: 74,
        redFlags: ['Q2 lacked a measurable outcome'],
        topImprovements: ['Use a clearer structure in Q1'],
        perQuestion: [
          {
            questionIndex: 0,
            question: 'First question',
            answer: 'Evaluation copy must not be rendered as transcript',
            score: 82,
            relevance: 84,
            structure: 80,
            specificity: 78,
            ownership: 86,
            jdAlignment: 75,
          },
          {
            questionIndex: 1,
            question: 'Second question',
            answer: 'Another evaluation copy',
            score: 72,
            relevance: 70,
            structure: null,
            specificity: null,
            ownership: 74,
            jdAlignment: null,
          },
        ],
      },
      transcript: [
        {
          speaker: 'interviewer',
          text: 'First question',
          timestampMs: 1_000,
          questionIndex: 0,
        },
        {
          speaker: 'candidate',
          text: 'Exact first answer.',
          timestampMs: 5_000,
          questionIndex: 0,
        },
        {
          speaker: 'interviewer',
          text: 'Second question',
          timestampMs: 20_000,
          questionIndex: 1,
        },
        {
          speaker: 'candidate',
          text: 'Exact second answer.',
          timestampMs: 25_000,
          questionIndex: 1,
        },
      ],
      media: [],
    })

    const { projection, evidenceIndex } =
      __resultIngestion.buildEvidenceProjection(input, IDS.attemptId)

    expect(projection.questions.map((question) => question.answer)).toEqual([
      'Exact first answer.',
      'Exact second answer.',
    ])
    expect(
      projection.dimensions.find(
        (dimension) => dimension.key === 'communication',
      ),
    ).toMatchObject({ evidenceIds: ['q-0-answer'] })
    expect(
      projection.dimensions.find(
        (dimension) => dimension.key === 'job_alignment',
      ),
    ).toMatchObject({ evidenceIds: ['q-0-answer'] })
    expect(
      projection.findings.find((finding) => finding.text.startsWith('Q2')),
    ).toMatchObject({ evidenceIds: ['q-1-answer'] })
    expect(
      projection.findings.find((finding) => finding.text.endsWith('Q1')),
    ).toMatchObject({ evidenceIds: ['q-0-answer'] })
    expect(
      evidenceIndex.find((evidence) => evidence.id === 'q-1-answer'),
    ).toMatchObject({
      transcriptExcerpt:
        'Interviewer: Second question\nCandidate: Exact second answer.',
    })
  })

  it('keeps repeated raw question indexes as distinct evidence-backed response moments', () => {
    const input = payload({
      results: {
        overallScore: 72,
        answerQualityScore: 74,
        communicationScore: 70,
        jdMatchScore: 68,
        redFlags: [],
        topImprovements: ['Q2 needs stronger detail'],
        perQuestion: [
          {
            questionIndex: 1,
            question: 'Describe the initial decision.',
            answer: 'Exact first response.',
            score: 70,
            relevance: 72,
            structure: 70,
            specificity: 68,
            ownership: 70,
            jdAlignment: 66,
            flags: ['First response gap'],
          },
          {
            questionIndex: 1,
            question: 'Explain the follow-up tradeoff.',
            answer: 'Exact follow-up response.',
            score: 74,
            relevance: 76,
            structure: 72,
            specificity: 74,
            ownership: 74,
            jdAlignment: 70,
            flags: ['Follow-up response gap'],
          },
        ],
      },
      transcript: [
        {
          speaker: 'interviewer',
          text: 'Describe the initial decision.',
          timestampMs: 1_000,
          questionIndex: 1,
        },
        {
          speaker: 'candidate',
          text: 'Exact first response.',
          timestampMs: 5_000,
          questionIndex: 1,
        },
        {
          speaker: 'interviewer',
          text: 'Explain the follow-up tradeoff.',
          timestampMs: 15_000,
          questionIndex: 1,
        },
        {
          speaker: 'candidate',
          text: 'Exact follow-up response.',
          timestampMs: 20_000,
          questionIndex: 1,
        },
        {
          speaker: 'interviewer',
          text: 'Next question.',
          timestampMs: 30_000,
          questionIndex: 2,
        },
      ],
      media: [],
    })

    const { projection, evidenceIndex } =
      __resultIngestion.buildEvidenceProjection(input, IDS.attemptId)

    expect(projection.questions).toMatchObject([
      {
        questionId: 'q-1',
        answer: 'Exact first response.',
        evidenceIds: ['q-1-answer'],
      },
      {
        questionId: 'q-1-2',
        answer: 'Exact follow-up response.',
        evidenceIds: ['q-1-2-answer'],
      },
    ])
    expect(evidenceIndex.map((evidence) => evidence.id)).toEqual([
      'q-1-answer',
      'q-1-2-answer',
    ])
    expect(new Set(evidenceIndex.map((evidence) => evidence.id)).size).toBe(
      evidenceIndex.length,
    )
    expect(evidenceIndex).toMatchObject([
      {
        transcriptStart: 0,
        transcriptEnd: 1,
        transcriptExcerpt:
          'Interviewer: Describe the initial decision.\nCandidate: Exact first response.',
      },
      {
        transcriptStart: 2,
        transcriptEnd: 3,
        transcriptExcerpt:
          'Interviewer: Explain the follow-up tradeoff.\nCandidate: Exact follow-up response.',
      },
    ])
    expect(
      projection.findings.find(
        (finding) => finding.text === 'First response gap',
      ),
    ).toMatchObject({ evidenceIds: ['q-1-answer'] })
    expect(
      projection.findings.find(
        (finding) => finding.text === 'Follow-up response gap',
      ),
    ).toMatchObject({ evidenceIds: ['q-1-2-answer'] })
    expect(
      projection.findings.find(
        (finding) => finding.text === 'Q2 needs stronger detail',
      ),
    ).toMatchObject({ evidenceIds: ['q-1-answer', 'q-1-2-answer'] })
  })

  it('reserves later exact answer matches before assigning positional fallbacks', () => {
    const input = payload({
      results: {
        overallScore: 70,
        perQuestion: [
          {
            questionIndex: 1,
            question: 'Response without an engine answer copy',
            score: 68,
            relevance: 68,
          },
          {
            questionIndex: 1,
            question: 'Response with an exact engine answer copy',
            answer: 'Transcript answer A.',
            score: 72,
            relevance: 72,
          },
        ],
      },
      transcript: [
        {
          speaker: 'interviewer',
          text: 'First prompt.',
          timestampMs: 1_000,
          questionIndex: 1,
        },
        {
          speaker: 'candidate',
          text: 'Transcript answer A.',
          timestampMs: 5_000,
          questionIndex: 1,
        },
        {
          speaker: 'interviewer',
          text: 'Follow-up prompt.',
          timestampMs: 10_000,
          questionIndex: 1,
        },
        {
          speaker: 'candidate',
          text: 'Transcript answer B.',
          timestampMs: 15_000,
          questionIndex: 1,
        },
      ],
      media: [],
    })

    const { projection, evidenceIndex } =
      __resultIngestion.buildEvidenceProjection(input, IDS.attemptId)

    expect(projection.questions).toMatchObject([
      {
        questionId: 'q-1',
        answer: 'Transcript answer B.',
        evidenceIds: ['q-1-answer'],
      },
      {
        questionId: 'q-1-2',
        answer: 'Transcript answer A.',
        evidenceIds: ['q-1-2-answer'],
      },
    ])
    expect(evidenceIndex).toMatchObject([
      { id: 'q-1-answer', transcriptStart: 2, transcriptEnd: 3 },
      { id: 'q-1-2-answer', transcriptStart: 0, transcriptEnd: 1 },
    ])
  })

  it('fails closed when a normalized answer cannot identify one of several same-index turns', () => {
    const input = payload({
      results: {
        overallScore: 80,
        perQuestion: [
          {
            questionIndex: 1,
            question: 'Explain the decision.',
            answer: 'An engine-normalized answer that is not in the transcript.',
            score: 80,
            relevance: 80,
          },
        ],
      },
      transcript: [
        {
          speaker: 'interviewer',
          text: 'Explain the decision.',
          timestampMs: 1_000,
          questionIndex: 1,
        },
        {
          speaker: 'candidate',
          text: 'Could you repeat that?',
          timestampMs: 5_000,
          questionIndex: 1,
        },
        {
          speaker: 'interviewer',
          text: 'Explain the decision and tradeoff.',
          timestampMs: 10_000,
          questionIndex: 1,
        },
        {
          speaker: 'candidate',
          text: 'The actual scored response.',
          timestampMs: 15_000,
          questionIndex: 1,
        },
      ],
      media: [],
    })

    expect(() =>
      __resultIngestion.buildEvidenceProjection(input, IDS.attemptId),
    ).toThrowError(
      expect.objectContaining({ code: 'evidence_missing', status: 409 }),
    )
  })

  it('does not infer transcript order for multiple unmatched duplicate-index results', () => {
    const input = payload({
      results: {
        overallScore: 80,
        perQuestion: [
          {
            questionIndex: 1,
            question: 'Evaluation completed second.',
            answer: 'Normalized response B.',
            score: 82,
            relevance: 82,
          },
          {
            questionIndex: 1,
            question: 'Evaluation completed first.',
            answer: 'Normalized response A.',
            score: 78,
            relevance: 78,
          },
        ],
      },
      transcript: [
        {
          speaker: 'interviewer',
          text: 'First prompt.',
          timestampMs: 1_000,
          questionIndex: 1,
        },
        {
          speaker: 'candidate',
          text: 'Verbatim response A.',
          timestampMs: 5_000,
          questionIndex: 1,
        },
        {
          speaker: 'interviewer',
          text: 'Follow-up prompt.',
          timestampMs: 10_000,
          questionIndex: 1,
        },
        {
          speaker: 'candidate',
          text: 'Verbatim response B.',
          timestampMs: 15_000,
          questionIndex: 1,
        },
      ],
      media: [],
    })

    expect(() =>
      __resultIngestion.buildEvidenceProjection(input, IDS.attemptId),
    ).toThrowError(
      expect.objectContaining({ code: 'evidence_missing', status: 409 }),
    )
  })

  it('fails closed when identical answer text occurs at multiple transcript moments', () => {
    const input = payload({
      results: {
        overallScore: 80,
        perQuestion: [
          {
            questionIndex: 1,
            question: 'Which repeated response was evaluated?',
            answer: 'The same response.',
            score: 80,
            relevance: 80,
          },
        ],
      },
      transcript: [
        {
          speaker: 'interviewer',
          text: 'First prompt.',
          timestampMs: 1_000,
          questionIndex: 1,
        },
        {
          speaker: 'candidate',
          text: 'The same response.',
          timestampMs: 5_000,
          questionIndex: 1,
        },
        {
          speaker: 'interviewer',
          text: 'Follow-up prompt.',
          timestampMs: 10_000,
          questionIndex: 1,
        },
        {
          speaker: 'candidate',
          text: 'The same response.',
          timestampMs: 15_000,
          questionIndex: 1,
        },
      ],
      media: [],
    })

    expect(() =>
      __resultIngestion.buildEvidenceProjection(input, IDS.attemptId),
    ).toThrowError(
      expect.objectContaining({ code: 'evidence_missing', status: 409 }),
    )
  })

  it('does not fall back after another result consumes the claimed exact answer', () => {
    const input = payload({
      results: {
        overallScore: 80,
        perQuestion: [
          {
            questionIndex: 1,
            question: 'First evaluation.',
            answer: 'Claimed response A.',
            score: 80,
            relevance: 80,
          },
          {
            questionIndex: 1,
            question: 'Conflicting second evaluation.',
            answer: 'Claimed response A.',
            score: 80,
            relevance: 80,
          },
        ],
      },
      transcript: [
        {
          speaker: 'interviewer',
          text: 'First prompt.',
          timestampMs: 1_000,
          questionIndex: 1,
        },
        {
          speaker: 'candidate',
          text: 'Claimed response A.',
          timestampMs: 5_000,
          questionIndex: 1,
        },
        {
          speaker: 'interviewer',
          text: 'Second prompt.',
          timestampMs: 10_000,
          questionIndex: 1,
        },
        {
          speaker: 'candidate',
          text: 'Different response B.',
          timestampMs: 15_000,
          questionIndex: 1,
        },
      ],
      media: [],
    })

    expect(() =>
      __resultIngestion.buildEvidenceProjection(input, IDS.attemptId),
    ).toThrowError(
      expect.objectContaining({ code: 'evidence_missing', status: 409 }),
    )
  })

  it('rejects timeline or media tampering before any database connection', async () => {
    const input = payload()
    input.durationMs += 1
    input.media[0].sha256 = '8'.repeat(64)

    await expect(
      ingestHireEngineResult(input),
    ).rejects.toMatchObject<HireEngineIngestionError>({
      code: 'digest_mismatch',
      status: 400,
    })
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(mocks.ingestMedia).not.toHaveBeenCalled()
  })

  it('binds durable media completion state into the immutable result digest', async () => {
    const input = payload({
      mediaCompletion: {
        contractVersion: 1,
        camera: { status: 'pending' },
        screen: { status: 'not_required' },
      },
    })
    input.mediaCompletion = {
      contractVersion: 1,
      camera: { status: 'unavailable', reason: 'retry_exhausted' },
      screen: { status: 'not_required' },
    }

    await expect(ingestHireEngineResult(input)).rejects.toMatchObject({
      code: 'digest_mismatch',
      status: 400,
    })
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(mocks.ingestMedia).not.toHaveBeenCalled()
  })

  it('requires the exact workspace-scoped attempt before ingesting media or evidence', async () => {
    mocks.attemptFindOne.mockReturnValue(query(null))
    await expect(
      ingestHireEngineResult(payload()),
    ).rejects.toMatchObject<HireEngineIngestionError>({
      code: 'not_found',
      status: 404,
    })
    expect(mocks.ingestMedia).not.toHaveBeenCalled()
    expect(mocks.persistResult).not.toHaveBeenCalled()
  })
})
