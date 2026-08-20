import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bindingFind: vi.fn(),
  bindingDistinct: vi.fn(),
  bindingUpdate: vi.fn(),
  sessionFindOne: vi.fn(),
  connect: vi.fn(),
  publish: vi.fn(),
  buildMedia: vi.fn(),
  deleteMedia: vi.fn(),
  events: [] as string[],
}))

vi.mock('../models/HireRuntimeBinding', () => ({
  HireRuntimeBinding: {
    find: mocks.bindingFind,
    distinct: mocks.bindingDistinct,
    updateOne: mocks.bindingUpdate,
  },
}))
vi.mock('@shared/db/models/InterviewSession', () => ({
  InterviewSession: { findOne: mocks.sessionFindOne },
}))
vi.mock('../services/runtimeBoundary', () => ({
  connectHireRuntimeDB: mocks.connect,
}))
vi.mock('../services/controlBridgeClient', () => ({
  publishResultToControl: mocks.publish,
}))
vi.mock('../services/runtimeMediaManifest', () => ({
  buildRuntimeMediaManifest: mocks.buildMedia,
  deleteRuntimeMediaManifest: mocks.deleteMedia,
}))

import {
  __resultPublisher,
  publishCompletedRuntimeResults,
} from '../services/resultPublisher'
import {
  HIRE_AI_CONSENT_VERSION,
  HIRE_AI_V5_CONSENT_VERSION,
} from '@hire-multimodal-boundary'

const WORKSPACE_ID = 'a'.repeat(24)
const APPLICATION_ID = 'b'.repeat(24)
const ROUND_ID = 'c'.repeat(24)
const PRINCIPAL_ID = 'd'.repeat(24)
const SESSION_ID = 'e'.repeat(24)
const CAMERA_KEY = `recordings/${PRINCIPAL_ID}/${SESSION_ID}-1723248000000.webm`
const SCREEN_KEY = `recordings/${PRINCIPAL_ID}/${SESSION_ID}-screen-1723248000001.webm`

function objectId(value: string) {
  return { toString: () => value }
}

function binding(overrides: Record<string, unknown> = {}) {
  return {
    _id: objectId('f'.repeat(24)),
    workspaceId: objectId(WORKSPACE_ID),
    applicationId: objectId(APPLICATION_ID),
    roundId: objectId(ROUND_ID),
    principalId: objectId(PRINCIPAL_ID),
    runtimeSessionId: objectId(SESSION_ID),
    status: 'active',
    attemptCount: 1,
    ...overrides,
  }
}

function completedSession(overrides: Record<string, unknown> = {}) {
  return {
    _id: objectId(SESSION_ID),
    status: 'completed',
    startedAt: new Date('2026-08-10T00:00:00.000Z'),
    completedAt: new Date('2026-08-10T00:05:00.000Z'),
    durationActualSeconds: 300,
    feedback: {
      overall_score: 80,
      dimensions: {
        answer_quality: { score: 80 },
        communication: { score: 80 },
      },
    },
    evaluations: [],
    transcript: [],
    recordingR2Key: CAMERA_KEY,
    recordingSizeBytes: 100,
    ...overrides,
  }
}

function sessionQuery(value: unknown) {
  return { select: () => ({ lean: async () => value }) }
}

const manifest = [
  {
    kind: 'recording' as const,
    sourceKey: CAMERA_KEY,
    contentType: 'video/webm',
    sizeBytes: 100,
    sha256: '1'.repeat(64),
  },
]

const audioManifest = [
  {
    kind: 'audio' as const,
    sourceKey: `recordings/${PRINCIPAL_ID}/${SESSION_ID}-audio-1723248000000.webm`,
    contentType: 'audio/webm',
    sizeBytes: 40,
    sha256: '2'.repeat(64),
  },
]

const screenManifest = [
  {
    kind: 'screen' as const,
    sourceKey: SCREEN_KEY,
    contentType: 'video/webm',
    sizeBytes: 200,
    sha256: '3'.repeat(64),
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  mocks.events.length = 0
  mocks.connect.mockResolvedValue(undefined)
  mocks.bindingDistinct.mockResolvedValue([WORKSPACE_ID])
  mocks.sessionFindOne.mockReturnValue(sessionQuery(completedSession()))
  mocks.buildMedia.mockImplementation(async () => {
    mocks.events.push('hash')
    return manifest
  })
  mocks.publish.mockImplementation(async () => {
    mocks.events.push('ack')
    return 'processed'
  })
  mocks.deleteMedia.mockImplementation(async () => {
    mocks.events.push('delete')
  })
  mocks.bindingUpdate.mockImplementation(async (_filter, update) => {
    if (update.$set?.pendingMediaManifest) mocks.events.push('stage')
    if (update.$set?.publishedRevision) mocks.events.push('complete')
    return { acknowledged: true, matchedCount: 1 }
  })
})

describe('runtime result publication lifecycle', () => {
  it('enumerates workspaces, then scans each tenant scope independently', async () => {
    const secondWorkspace = '9'.repeat(24)
    mocks.bindingDistinct.mockResolvedValueOnce([WORKSPACE_ID, secondWorkspace])
    mocks.bindingFind.mockImplementation(() => ({
      sort: () => ({ limit: async () => [] }),
    }))

    await expect(publishCompletedRuntimeResults(10)).resolves.toEqual({
      scanned: 0,
      published: 0,
      skipped: 0,
      failed: 0,
    })
    expect(mocks.bindingDistinct).toHaveBeenCalledWith('workspaceId', {
      workspaceId: { $exists: true },
    })
    expect(
      mocks.bindingFind.mock.calls.map(([filter]) => filter.workspaceId),
    ).toEqual([secondWorkspace, WORKSPACE_ID])
  })

  it('persists the verified manifest, waits for control ack, deletes sources, then publishes the marker', async () => {
    await expect(
      __resultPublisher.publishRuntimeBindingResult(binding() as never),
    ).resolves.toBe('published')

    expect(mocks.events).toEqual(['hash', 'stage', 'ack', 'delete', 'complete'])
    expect(mocks.deleteMedia).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID,
      runtimeSessionId: SESSION_ID,
      media: manifest,
    })
    expect(mocks.bindingUpdate.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: { publishedRevision: 1, cameraMediaStatus: 'published' },
      $unset: { pendingMediaManifest: 1 },
    })
  })

  it('publishes the scorecard first, then delivers a late camera recording in revision 2', async () => {
    mocks.sessionFindOne.mockReturnValueOnce(
      sessionQuery(completedSession({ recordingR2Key: null, recordingSizeBytes: null })),
    )
    mocks.buildMedia.mockResolvedValueOnce([])

    await expect(
      __resultPublisher.publishRuntimeBindingResult(binding() as never),
    ).resolves.toBe('published')

    expect(mocks.publish.mock.calls[0][0]).toMatchObject({ revision: 1, media: [] })
    expect(mocks.bindingUpdate.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: {
        publishedRevision: 1,
        cameraMediaStatus: 'pending',
        status: 'completed',
        publishRetryAt: expect.any(Date),
      },
    })

    mocks.sessionFindOne.mockReturnValueOnce(sessionQuery(completedSession()))
    mocks.buildMedia.mockResolvedValueOnce(manifest)

    await expect(
      __resultPublisher.publishRuntimeBindingResult(
        binding({ publishedRevision: 1, cameraMediaStatus: 'pending' }) as never,
      ),
    ).resolves.toBe('published')

    expect(mocks.publish.mock.calls[1][0]).toMatchObject({
      revision: 2,
      media: manifest,
    })
    expect(mocks.deleteMedia.mock.calls).toEqual([
      [
        {
          principalId: PRINCIPAL_ID,
          runtimeSessionId: SESSION_ID,
          media: [],
        },
      ],
      [
        {
          principalId: PRINCIPAL_ID,
          runtimeSessionId: SESSION_ID,
          media: manifest,
        },
      ],
    ])
    expect(mocks.bindingUpdate.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: {
        publishedRevision: 2,
        cameraMediaStatus: 'published',
        status: 'completed',
      },
      $unset: { pendingMediaManifest: 1, publishRetryAt: 1 },
    })
  })

  it('publishes independently finalized V6 camera and display recordings in ordered late revisions', async () => {
    mocks.sessionFindOne.mockReturnValueOnce(
      sessionQuery(
        completedSession({
          recordingR2Key: null,
          recordingSizeBytes: null,
          screenRecordingR2Key: null,
          screenRecordingSizeBytes: null,
        }),
      ),
    )
    mocks.buildMedia.mockResolvedValueOnce([])

    await expect(
      __resultPublisher.publishRuntimeBindingResult(
        binding({ consentVersion: HIRE_AI_CONSENT_VERSION }) as never,
      ),
    ).resolves.toBe('published')

    expect(mocks.bindingUpdate.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: {
        publishedRevision: 1,
        cameraMediaStatus: 'pending',
        screenMediaStatus: 'pending',
        status: 'completed',
        publishRetryAt: expect.any(Date),
      },
    })

    mocks.sessionFindOne.mockReturnValueOnce(
      sessionQuery(
        completedSession({
          screenRecordingR2Key: null,
          screenRecordingSizeBytes: null,
        }),
      ),
    )
    mocks.buildMedia.mockResolvedValueOnce(manifest)

    await expect(
      __resultPublisher.publishRuntimeBindingResult(
        binding({
          consentVersion: HIRE_AI_CONSENT_VERSION,
          publishedRevision: 1,
          cameraMediaStatus: 'pending',
          screenMediaStatus: 'pending',
        }) as never,
      ),
    ).resolves.toBe('published')

    expect(mocks.publish.mock.calls[1][0]).toMatchObject({
      revision: 2,
      media: manifest,
    })
    expect(mocks.bindingUpdate.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: {
        publishedRevision: 2,
        cameraMediaStatus: 'published',
        screenMediaStatus: 'pending',
        status: 'completed',
        publishRetryAt: expect.any(Date),
      },
    })

    mocks.sessionFindOne.mockReturnValueOnce(
      sessionQuery(
        completedSession({
          screenRecordingR2Key: SCREEN_KEY,
          screenRecordingSizeBytes: 200,
        }),
      ),
    )
    mocks.buildMedia.mockResolvedValueOnce(screenManifest)

    await expect(
      __resultPublisher.publishRuntimeBindingResult(
        binding({
          consentVersion: HIRE_AI_CONSENT_VERSION,
          publishedRevision: 2,
          cameraMediaStatus: 'published',
          screenMediaStatus: 'pending',
        }) as never,
      ),
    ).resolves.toBe('published')

    expect(mocks.publish.mock.calls[2][0]).toMatchObject({
      revision: 3,
      media: screenManifest,
    })
    const finalUpdate = mocks.bindingUpdate.mock.calls.at(-1)?.[1]
    expect(finalUpdate).toMatchObject({
      $set: {
        publishedRevision: 3,
        screenMediaStatus: 'published',
        status: 'completed',
      },
      $unset: { pendingMediaManifest: 1, publishRetryAt: 1 },
    })
    expect(finalUpdate.$set).not.toHaveProperty('cameraMediaStatus')
  })

  it('keeps camera delivery pending when revision 1 contains only audio', async () => {
    mocks.sessionFindOne.mockReturnValueOnce(
      sessionQuery(completedSession({ recordingR2Key: null, recordingSizeBytes: null })),
    )
    mocks.buildMedia.mockResolvedValueOnce(audioManifest)

    await expect(
      __resultPublisher.publishRuntimeBindingResult(binding() as never),
    ).resolves.toBe('published')

    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 1, media: audioManifest }),
    )
    expect(mocks.bindingUpdate.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: {
        publishedRevision: 1,
        cameraMediaStatus: 'pending',
        publishRetryAt: expect.any(Date),
      },
    })
  })

  it('does not discover or publish display media for a V5 binding', async () => {
    mocks.sessionFindOne.mockReturnValueOnce(
      sessionQuery(
        completedSession({
          screenRecordingR2Key: SCREEN_KEY,
          screenRecordingSizeBytes: 200,
        }),
      ),
    )

    await expect(
      __resultPublisher.publishRuntimeBindingResult(
        binding({ consentVersion: HIRE_AI_V5_CONSENT_VERSION }) as never,
      ),
    ).resolves.toBe('published')

    const manifestInput = mocks.buildMedia.mock.calls[0][0]
    expect(manifestInput).not.toHaveProperty('screenRecordingR2Key')
    expect(manifestInput).not.toHaveProperty('screenRecordingSizeBytes')
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({ media: manifest }),
    )
    expect(mocks.bindingUpdate.mock.calls.at(-1)?.[1].$set).not.toHaveProperty(
      'screenMediaStatus',
    )
  })

  it('rejects a persisted screen manifest unless consent is the exact V6 version', async () => {
    await expect(
      __resultPublisher.publishRuntimeBindingResult(
        binding({
          consentVersion: `${HIRE_AI_CONSENT_VERSION}-forged`,
          pendingMediaManifest: screenManifest,
        }) as never,
      ),
    ).rejects.toThrow(/not consented/)

    expect(mocks.publish).not.toHaveBeenCalled()
    expect(mocks.deleteMedia).not.toHaveBeenCalled()
  })

  it('does not republish revision 1 while a late camera upload is still absent', async () => {
    mocks.sessionFindOne.mockReturnValueOnce(
      sessionQuery(completedSession({ recordingR2Key: null, recordingSizeBytes: null })),
    )
    mocks.buildMedia.mockResolvedValueOnce([])

    await expect(
      __resultPublisher.publishRuntimeBindingResult(
        binding({ publishedRevision: 1, cameraMediaStatus: 'pending' }) as never,
      ),
    ).resolves.toBe('skipped')

    expect(mocks.publish).not.toHaveBeenCalled()
    expect(mocks.deleteMedia).not.toHaveBeenCalled()
    expect(mocks.buildMedia).toHaveBeenCalledWith(
      expect.not.objectContaining({
        audioRecordingR2Key: expect.anything(),
        audioRecordingSizeBytes: expect.anything(),
      }),
    )
    expect(mocks.bindingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        publishedRevision: 1,
        cameraMediaStatus: 'pending',
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ publishRetryAt: expect.any(Date) }),
      }),
    )
  })

  it('leaves the binding unpublished when source deletion fails after control ack', async () => {
    mocks.deleteMedia.mockImplementationOnce(async () => {
      mocks.events.push('delete')
      throw new Error('R2 unavailable')
    })

    await expect(
      __resultPublisher.publishRuntimeBindingResult(binding() as never),
    ).rejects.toThrow('R2 unavailable')
    expect(mocks.events).toEqual(['hash', 'stage', 'ack', 'delete'])
    expect(
      mocks.bindingUpdate.mock.calls.some(([, update]) => update.$set?.publishedRevision === 1),
    ).toBe(false)
  })

  it('reuses a durable manifest after partial cleanup and accepts a duplicate control ack', async () => {
    mocks.publish.mockImplementationOnce(async () => {
      mocks.events.push('ack')
      return 'duplicate'
    })

    await __resultPublisher.publishRuntimeBindingResult(
      binding({ pendingMediaManifest: manifest }) as never,
    )
    expect(mocks.buildMedia).not.toHaveBeenCalled()
    expect(mocks.events).toEqual(['ack', 'delete', 'complete'])
  })

  it('does not read or publish a stale scan row after privacy revocation wins', async () => {
    mocks.bindingUpdate.mockResolvedValueOnce({
      acknowledged: true,
      matchedCount: 0,
    })

    await expect(
      __resultPublisher.publishRuntimeBindingResult(binding() as never),
    ).rejects.toThrow(/no longer publishable/)
    expect(mocks.sessionFindOne).not.toHaveBeenCalled()
    expect(mocks.publish).not.toHaveBeenCalled()
    expect(mocks.deleteMedia).not.toHaveBeenCalled()
  })

  it('isolates a malformed binding, records backoff, and continues later results', async () => {
    const malformedSessionId = '2'.repeat(24)
    const malformed = binding({
      _id: objectId('3'.repeat(24)),
      runtimeSessionId: objectId(malformedSessionId),
    })
    const healthy = binding()
    mocks.bindingFind.mockReturnValue({
      sort: () => ({ limit: async () => [malformed, healthy] }),
    })
    mocks.sessionFindOne.mockImplementation((query) =>
      sessionQuery(
        query._id.toString() === malformedSessionId
          ? completedSession({ _id: objectId(malformedSessionId), startedAt: null })
          : completedSession(),
      ),
    )

    await expect(publishCompletedRuntimeResults()).resolves.toEqual({
      scanned: 2,
      published: 1,
      skipped: 0,
      failed: 1,
    })
    expect(
      mocks.bindingUpdate.mock.calls.some(([, update]) =>
        update.$set?.publishFailureCode === 'RUNTIME_RESULT_PUBLISH_FAILED'),
    ).toBe(true)
    expect(mocks.publish).toHaveBeenCalledOnce()
  })

  it('scans pending replay revisions but not terminal published bindings', async () => {
    mocks.bindingFind.mockImplementation(() => ({
      sort: () => ({ limit: async () => [] }),
    }))

    await publishCompletedRuntimeResults(10)

    const filter = mocks.bindingFind.mock.calls[0][0]
    expect(filter.$and).toEqual([
      {
        $or: [
          { publishedRevision: { $exists: false } },
          {
            publishedRevision: { $gte: 1, $lt: 10 },
            cameraMediaStatus: 'pending',
          },
          {
            publishedRevision: { $gte: 1, $lt: 10 },
            screenMediaStatus: 'pending',
          },
        ],
      },
      {
        $or: [
          { publishRetryAt: { $exists: false } },
          { publishRetryAt: { $lte: expect.any(Date) } },
        ],
      },
    ])
  })
})
