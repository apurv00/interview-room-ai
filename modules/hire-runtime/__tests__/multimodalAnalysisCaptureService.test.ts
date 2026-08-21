import { beforeEach, describe, expect, it, vi } from 'vitest'
import mongoose from 'mongoose'
import { HIRE_AI_CONSENT_VERSION } from '@hire/policies/aiInterviewConsent'

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  connect: vi.fn(),
  bindingFindOne: vi.fn(),
  bindingUpdateOne: vi.fn(),
  outboxFindOne: vi.fn(),
  outboxFindOneAndUpdate: vi.fn(),
  outboxCreate: vi.fn(),
  outboxUpdateOne: vi.fn(),
  outboxDeleteMany: vi.fn(),
  sessionExists: vi.fn(),
  sessionUpdateOne: vi.fn(),
  uploadLandmark: vi.fn(),
  deleteObjects: vi.fn(),
  retentionExists: vi.fn(),
  startSession: vi.fn(),
}))

vi.mock('../services/runtimeBoundary', () => ({
  connectHireRuntimeDB: mocks.connect,
}))
vi.mock('../models/HireRuntimeBinding', () => ({
  HireRuntimeBinding: {
    findOne: mocks.bindingFindOne,
    updateOne: mocks.bindingUpdateOne,
  },
}))
vi.mock('../models/HireRuntimeMultimodalAnalysisOutbox', () => ({
  HireRuntimeMultimodalAnalysisOutbox: {
    findOne: mocks.outboxFindOne,
    findOneAndUpdate: mocks.outboxFindOneAndUpdate,
    create: mocks.outboxCreate,
    updateOne: mocks.outboxUpdateOne,
    deleteMany: mocks.outboxDeleteMany,
  },
}))
vi.mock('@shared/db/models/InterviewSession', () => ({
  InterviewSession: {
    exists: mocks.sessionExists,
    updateOne: mocks.sessionUpdateOne,
  },
}))
vi.mock('../services/runtimeMediaManifest', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../services/runtimeMediaManifest')
  >()
  return {
    ...actual,
    uploadRuntimeLandmarkObject: mocks.uploadLandmark,
    deleteRuntimePersonalObjects: mocks.deleteObjects,
  }
})
vi.mock('../services/multimodalObservationRetentionService', () => ({
  isHireRuntimeMultimodalObservationRetentionPurged: mocks.retentionExists,
}))

import {
  __hireRuntimeMultimodalAnalysisCapture,
  captureHireRuntimeMultimodalAnalysis,
} from '../services/multimodalAnalysisCaptureService'

const IDS = {
  binding: 'a'.repeat(24),
  workspace: 'b'.repeat(24),
  application: 'c'.repeat(24),
  round: 'd'.repeat(24),
  principal: 'e'.repeat(24),
  session: 'f'.repeat(24),
}

function objectId(value: string) {
  return { toString: () => value }
}

function binding(overrides: Record<string, unknown> = {}) {
  return {
    _id: objectId(IDS.binding),
    workspaceId: objectId(IDS.workspace),
    applicationId: objectId(IDS.application),
    roundId: objectId(IDS.round),
    principalId: objectId(IDS.principal),
    runtimeSessionId: objectId(IDS.session),
    attemptCount: 1,
    status: 'completed',
    consentVersion: HIRE_AI_CONSENT_VERSION,
    ...overrides,
  }
}

function query(value: unknown) {
  return { select: () => ({ lean: async () => value }) }
}

function leanQuery(value: unknown) {
  return { lean: async () => value }
}

function capture() {
  return {
    sessionId: IDS.session,
    frames: [{
      ts: 1,
      gazeX: 0,
      gazeY: 0,
      headPoseYaw: 0,
      headPosePitch: 0,
      expression: 'focused' as const,
      eyeContactScore: 0.9,
      blendshapes: { browDownLeft: 0.2 },
    }],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.events.length = 0
  vi.spyOn(mongoose, 'startSession').mockImplementation(mocks.startSession)
  mocks.startSession.mockResolvedValue({
    withTransaction: vi.fn(async (work) => work()),
    endSession: vi.fn().mockResolvedValue(undefined),
  })
  mocks.connect.mockResolvedValue(undefined)
  mocks.bindingFindOne.mockResolvedValue(binding())
  mocks.bindingUpdateOne.mockImplementation(async (_filter, update, options) => {
    const reservedKey = update.$push?.issuedObjectCapabilities?.key
    const releasedKey = update.$pull?.issuedObjectCapabilities?.key
    if (reservedKey) mocks.events.push(`reserve:${reservedKey}`)
    if (releasedKey) {
      mocks.events.push(`${options?.session ? 'handoff' : 'release'}:${releasedKey}`)
    }
    return { acknowledged: true, matchedCount: 1 }
  })
  mocks.outboxFindOne.mockReturnValue(query(null))
  mocks.outboxFindOneAndUpdate.mockReturnValue(leanQuery(null))
  mocks.outboxCreate.mockImplementation(async ([document]) => {
    mocks.events.push('outbox')
    return [{ _id: objectId('9'.repeat(24)), ...document }]
  })
  mocks.outboxUpdateOne.mockImplementation(async () => {
    mocks.events.push('activate')
    return { acknowledged: true, matchedCount: 1 }
  })
  mocks.outboxDeleteMany.mockResolvedValue({ acknowledged: true, deletedCount: 1 })
  mocks.sessionExists.mockResolvedValue({ _id: objectId(IDS.session) })
  mocks.sessionUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.uploadLandmark.mockImplementation(async ({ key }) => {
    mocks.events.push(`upload:${key}`)
  })
  mocks.deleteObjects.mockImplementation(async ({ objects }) => {
    mocks.events.push(`delete:${objects[0].key}`)
  })
  mocks.retentionExists.mockResolvedValue(false)
})

describe('Hire full-analysis landmark capture', () => {
  it('uses an opaque v2 key bound to the exact principal/session coordinates', () => {
    const key = __hireRuntimeMultimodalAnalysisCapture.runtimeLandmarkKey(
      IDS.principal,
      IDS.session,
      '1'.repeat(__hireRuntimeMultimodalAnalysisCapture.LANDMARK_CAPTURE_NONCE_HEX_LENGTH),
    )
    expect(key).toMatch(/^landmarks\/v2\/[a-f0-9]{64}$/)
    expect(key).not.toContain('1'.repeat(64))
    expect(key).not.toContain(IDS.principal)
    expect(key).not.toContain(IDS.session)
  })

  it('persists the exact cleanup obligation before upload and releases it only after outbox handoff', async () => {
    await expect(captureHireRuntimeMultimodalAnalysis({
      workspaceId: IDS.workspace,
      principalId: IDS.principal,
      capture: capture(),
    })).resolves.toBe('accepted')

    const key = mocks.uploadLandmark.mock.calls[0]?.[0].key
    const objectKeyNonce = mocks.uploadLandmark.mock.calls[0]?.[0].objectKeyNonce
    expect(key).toEqual(expect.any(String))
    expect(objectKeyNonce).toMatch(/^[a-f0-9]{64}$/)
    expect(key).not.toContain(objectKeyNonce)
    const reservation = mocks.bindingUpdateOne.mock.calls.find(
      ([, update]) => update.$push?.issuedObjectCapabilities?.key === key,
    )
    expect(reservation?.[0]._id.toString()).toBe(IDS.binding)
    expect(reservation?.[0].workspaceId.toString()).toBe(IDS.workspace)
    expect(reservation?.[0].purgePersonalData).toEqual({ $ne: true })
    expect(reservation?.[0].attemptCount).toBe(1)
    expect(reservation?.[1]).toMatchObject({
      $push: {
        issuedObjectCapabilities: {
          key,
          objectKeyNonce,
          expiresAt: expect.any(Date),
        },
      },
      $max: { runtimeWriteDrainUntil: expect.any(Date) },
    })
    expect(
      reservation?.[1].$push.issuedObjectCapabilities.runtimeSessionId.toString(),
    ).toBe(IDS.session)
    expect(mocks.outboxCreate.mock.calls[0]?.[0]?.[0]).toEqual(
      expect.objectContaining({
        payloadSnapshotProtocolVersion: 1,
        status: 'staging',
        stagingLeaseToken: expect.stringMatching(/^[a-f0-9]{32}$/),
        stagingLeaseExpiresAt: expect.any(Date),
        landmarkArtifact: expect.objectContaining({
          sourceKey: key,
          objectKeyNonce,
        }),
      }),
    )
    expect(mocks.outboxCreate.mock.calls[0]?.[1]).toEqual({
      session: expect.any(Object),
    })
    expect(reservation?.[2]).toEqual({
      writeConcern: { w: 'majority', j: true },
      runValidators: true,
    })
    expect(mocks.events.indexOf(`reserve:${key}`)).toBeLessThan(
      mocks.events.indexOf(`handoff:${key}`),
    )
    expect(mocks.events.indexOf(`handoff:${key}`)).toBeLessThan(
      mocks.events.indexOf('outbox'),
    )
    const handoff = mocks.bindingUpdateOne.mock.calls.find(
      ([, update, options]) => options?.session &&
        update.$pull?.issuedObjectCapabilities?.key === key,
    )
    expect(handoff?.[0].attemptCount).toBe(1)
    expect(handoff?.[0].issuedObjectCapabilities.$elemMatch).toMatchObject({
      key,
      objectKeyNonce,
    })
    expect(mocks.events.indexOf('outbox')).toBeLessThan(
      mocks.events.indexOf(`upload:${key}`),
    )
    expect(mocks.events.indexOf(`upload:${key}`)).toBeLessThan(
      mocks.events.indexOf('activate'),
    )
    expect(mocks.outboxUpdateOne.mock.calls[0]?.[1]).toEqual({
      $set: { status: 'pending' },
      $unset: { stagingLeaseToken: 1, stagingLeaseExpiresAt: 1 },
    })
    expect(mocks.outboxUpdateOne.mock.calls[0]?.[2]).toEqual({
      writeConcern: { w: 'majority', j: true },
    })
  })

  it('never seals an active capture while another request is between Put ACK and publishable activation', async () => {
    let releaseActivation!: () => void
    let reportActivationStarted!: () => void
    const activationStarted = new Promise<void>((resolve) => {
      reportActivationStarted = resolve
    })
    mocks.outboxFindOne
      .mockReturnValueOnce(query(null))
      .mockImplementationOnce(() => {
        const sourceKey = mocks.uploadLandmark.mock.calls[0]?.[0].key
        return query({
          status: 'staging',
          capturedAt: new Date('2026-08-21T16:00:00.000Z'),
          landmarkArtifact: { sourceKey },
        })
      })
    mocks.outboxUpdateOne.mockImplementationOnce(async () => {
      reportActivationStarted()
      await new Promise<void>((resolve) => {
        releaseActivation = resolve
      })
      return { acknowledged: true, matchedCount: 1 }
    })

    const first = captureHireRuntimeMultimodalAnalysis({
      workspaceId: IDS.workspace,
      principalId: IDS.principal,
      capture: capture(),
      now: new Date('2026-08-21T16:00:00.000Z'),
    })
    await activationStarted
    const firstKey = mocks.uploadLandmark.mock.calls[0]?.[0].key as string
    mocks.bindingFindOne.mockResolvedValueOnce(binding({
      issuedObjectCapabilities: [{
        key: firstKey,
        runtimeSessionId: objectId(IDS.session),
        expiresAt: new Date('2026-08-21T16:06:00.000Z'),
      }],
    }))

    await expect(captureHireRuntimeMultimodalAnalysis({
      workspaceId: IDS.workspace,
      principalId: IDS.principal,
      capture: capture(),
      now: new Date('2026-08-21T16:00:01.000Z'),
    })).resolves.toBe('already_captured')

    expect(mocks.deleteObjects.mock.calls.some(([input]) =>
      input.objects.some(({ key }: { key: string }) => key === firstKey),
    )).toBe(false)
    releaseActivation()
    await expect(first).resolves.toBe('accepted')
    expect(mocks.sessionUpdateOne).not.toHaveBeenCalled()
  })

  it('does not reserve an artifact after the binding advances to another attempt', async () => {
    mocks.bindingUpdateOne.mockResolvedValueOnce({
      acknowledged: true,
      matchedCount: 0,
    })

    await expect(captureHireRuntimeMultimodalAnalysis({
      workspaceId: IDS.workspace,
      principalId: IDS.principal,
      capture: capture(),
    })).resolves.toBe('disabled')

    expect(mocks.bindingUpdateOne.mock.calls[0]?.[0]).toMatchObject({
      _id: expect.any(Object),
      attemptCount: 1,
      runtimeSessionId: expect.any(Object),
    })
    expect(mocks.startSession).not.toHaveBeenCalled()
    expect(mocks.uploadLandmark).not.toHaveBeenCalled()
    expect(mocks.outboxCreate).not.toHaveBeenCalled()
  })

  it('seals the reserved key if the attempt advances before transactional handoff', async () => {
    mocks.bindingUpdateOne
      .mockResolvedValueOnce({ acknowledged: true, matchedCount: 1 })
      .mockResolvedValueOnce({ acknowledged: true, matchedCount: 0 })
      .mockResolvedValueOnce({ acknowledged: true, matchedCount: 1 })

    await expect(captureHireRuntimeMultimodalAnalysis({
      workspaceId: IDS.workspace,
      principalId: IDS.principal,
      capture: capture(),
    })).resolves.toBe('disabled')

    const handoff = mocks.bindingUpdateOne.mock.calls[1]
    expect(handoff?.[0]).toMatchObject({
      attemptCount: 1,
      status: { $in: ['active', 'completed'] },
      multimodalObservationRetentionPurgedAt: { $exists: false },
    })
    expect(handoff?.[2]).toEqual({ session: expect.any(Object) })
    expect(mocks.outboxCreate).not.toHaveBeenCalled()
    expect(mocks.uploadLandmark).not.toHaveBeenCalled()
    expect(mocks.deleteObjects).toHaveBeenCalledOnce()
  })

  it('seals and removes a crash-before-Put staging row only after its token-fenced lease expires', async () => {
    const now = new Date('2026-08-21T16:10:00.000Z')
    const expiredObjectKeyNonce = '2'.repeat(
      __hireRuntimeMultimodalAnalysisCapture.LANDMARK_CAPTURE_NONCE_HEX_LENGTH,
    )
    const expiredKey = __hireRuntimeMultimodalAnalysisCapture.runtimeLandmarkKey(
      IDS.principal,
      IDS.session,
      expiredObjectKeyNonce,
    )
    const expiredToken = '3'.repeat(
      __hireRuntimeMultimodalAnalysisCapture.LANDMARK_STAGING_LEASE_TOKEN_HEX_LENGTH,
    )
    const expired = {
      _id: objectId('7'.repeat(24)),
      status: 'staging' as const,
      capturedAt: new Date('2026-08-21T16:00:00.000Z'),
      stagingLeaseToken: expiredToken,
      stagingLeaseExpiresAt: new Date('2026-08-21T16:06:00.000Z'),
      landmarkArtifact: {
        sourceKey: expiredKey,
        objectKeyNonce: expiredObjectKeyNonce,
      },
    }
    mocks.outboxFindOne.mockReturnValueOnce(query(expired))
    mocks.outboxFindOneAndUpdate.mockImplementationOnce(
      (_filter, update) => leanQuery({ ...expired, ...update.$set }),
    )

    await expect(captureHireRuntimeMultimodalAnalysis({
      workspaceId: IDS.workspace,
      principalId: IDS.principal,
      capture: capture(),
      now,
    })).resolves.toBe('accepted')

    const claim = mocks.outboxFindOneAndUpdate.mock.calls[0]
    expect(claim?.[0]).toMatchObject({
      _id: expired._id,
      status: 'staging',
      stagingLeaseToken: expiredToken,
      stagingLeaseExpiresAt: { $lte: now },
      'landmarkArtifact.sourceKey': expiredKey,
      'landmarkArtifact.objectKeyNonce': expiredObjectKeyNonce,
    })
    expect(claim?.[1].$set).toMatchObject({
      status: 'staging_cleanup',
      stagingLeaseToken: expect.stringMatching(/^[a-f0-9]{32}$/),
      stagingLeaseExpiresAt: expect.any(Date),
      failureCode:
        __hireRuntimeMultimodalAnalysisCapture.LANDMARK_STAGING_CLEANUP_FAILURE_CODE,
    })
    const cleanupToken = claim?.[1].$set.stagingLeaseToken
    expect(mocks.outboxDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: expired._id,
        status: 'staging_cleanup',
        stagingLeaseToken: cleanupToken,
        'landmarkArtifact.sourceKey': expiredKey,
        'landmarkArtifact.objectKeyNonce': expiredObjectKeyNonce,
      }),
      { writeConcern: { w: 'majority', j: true } },
    )
    const replacementKey = mocks.uploadLandmark.mock.calls[0]?.[0].key as string
    expect(replacementKey).not.toBe(expiredKey)
    expect(mocks.events.indexOf(`delete:${expiredKey}`)).toBeLessThan(
      mocks.events.indexOf(`reserve:${replacementKey}`),
    )
  })

  it('fences an ambiguous expired Put before retrying without sealing the fresh writer', async () => {
    const firstNow = new Date('2026-08-21T16:00:00.000Z')
    const retryNow = new Date('2026-08-21T16:06:00.001Z')
    let releaseFirstUpload!: () => void
    let reportFirstUploadStarted!: () => void
    const firstUploadStarted = new Promise<void>((resolve) => {
      reportFirstUploadStarted = resolve
    })
    mocks.uploadLandmark
      .mockImplementationOnce(async ({ key }) => {
        mocks.events.push(`upload:${key}`)
        reportFirstUploadStarted()
        await new Promise<void>((resolve) => {
          releaseFirstUpload = resolve
        })
      })
      .mockImplementationOnce(async ({ key }) => {
        mocks.events.push(`upload:${key}`)
      })
    mocks.outboxCreate
      .mockImplementationOnce(async ([document]) => [{
        _id: objectId('6'.repeat(24)),
        ...document,
      }])
      .mockImplementationOnce(async ([document]) => [{
        _id: objectId('5'.repeat(24)),
        ...document,
      }])

    const first = captureHireRuntimeMultimodalAnalysis({
      workspaceId: IDS.workspace,
      principalId: IDS.principal,
      capture: capture(),
      now: firstNow,
    })
    await firstUploadStarted
    const firstStaged = mocks.outboxCreate.mock.calls[0]?.[0]?.[0]
    mocks.outboxFindOne.mockReturnValueOnce(query({
      _id: objectId('6'.repeat(24)),
      status: 'staging',
      capturedAt: firstStaged.capturedAt,
      stagingLeaseToken: firstStaged.stagingLeaseToken,
      stagingLeaseExpiresAt: firstStaged.stagingLeaseExpiresAt,
      landmarkArtifact: firstStaged.landmarkArtifact,
    }))
    mocks.outboxFindOneAndUpdate.mockImplementationOnce(
      (_filter, update) => leanQuery({
        _id: objectId('6'.repeat(24)),
        status: update.$set.status,
        capturedAt: firstStaged.capturedAt,
        stagingLeaseToken: update.$set.stagingLeaseToken,
        stagingLeaseExpiresAt: update.$set.stagingLeaseExpiresAt,
        landmarkArtifact: firstStaged.landmarkArtifact,
      }),
    )
    mocks.outboxUpdateOne.mockImplementation(async (filter) => {
      mocks.events.push('activate')
      return {
        acknowledged: true,
        matchedCount:
          filter['landmarkArtifact.sourceKey'] ===
          firstStaged.landmarkArtifact.sourceKey
            ? 0
            : 1,
      }
    })

    await expect(captureHireRuntimeMultimodalAnalysis({
      workspaceId: IDS.workspace,
      principalId: IDS.principal,
      capture: capture(),
      now: retryNow,
    })).resolves.toBe('accepted')

    const replacementKey = mocks.uploadLandmark.mock.calls[1]?.[0].key as string
    expect(replacementKey).not.toBe(firstStaged.landmarkArtifact.sourceKey)
    expect(mocks.deleteObjects).toHaveBeenCalledWith({
      principalId: IDS.principal,
      objects: [{
        key: firstStaged.landmarkArtifact.sourceKey,
        runtimeSessionId: IDS.session,
        objectKeyNonce: firstStaged.landmarkArtifact.objectKeyNonce,
      }],
    })
    expect(mocks.deleteObjects.mock.calls.some(([input]) =>
      input.objects.some(({ key }: { key: string }) => key === replacementKey),
    )).toBe(false)

    releaseFirstUpload()
    await expect(first).rejects.toThrow(/publishable outbox handoff/)
    expect(mocks.deleteObjects.mock.calls.some(([input]) =>
      input.objects.some(({ key }: { key: string }) => key === replacementKey),
    )).toBe(false)
  })

  it('does not recreate pending metadata when privacy purge deletes staging during a delayed upload', async () => {
    let releaseUpload!: () => void
    let reportUploadStarted!: () => void
    const uploadStarted = new Promise<void>((resolve) => {
      reportUploadStarted = resolve
    })
    mocks.uploadLandmark.mockImplementationOnce(async ({ key }) => {
      mocks.events.push(`upload:${key}`)
      reportUploadStarted()
      await new Promise<void>((resolve) => {
        releaseUpload = resolve
      })
    })
    mocks.outboxUpdateOne.mockResolvedValueOnce({
      acknowledged: true,
      matchedCount: 0,
    })

    const captureAttempt = captureHireRuntimeMultimodalAnalysis({
      workspaceId: IDS.workspace,
      principalId: IDS.principal,
      capture: capture(),
    })
    await uploadStarted
    // Represents privacy purge sealing the key and deleting the staging row
    // while the conditional Put response is still delayed.
    releaseUpload()

    await expect(captureAttempt).rejects.toThrow(/publishable outbox handoff/)
    expect(mocks.outboxCreate).toHaveBeenCalledOnce()
    expect(mocks.outboxCreate.mock.calls[0]?.[0]?.[0].status).toBe('staging')
    expect(mocks.outboxUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'staging' }),
      {
        $set: { status: 'pending' },
        $unset: { stagingLeaseToken: 1, stagingLeaseExpiresAt: 1 },
      },
      { writeConcern: { w: 'majority', j: true } },
    )
    expect(mocks.deleteObjects).toHaveBeenCalledOnce()
  })

  it('keeps the winning source object intact when simultaneous captures race on the outbox key', async () => {
    mocks.outboxCreate
      .mockResolvedValueOnce([{ _id: objectId('8'.repeat(24)) }])
      .mockRejectedValueOnce({ code: 11000 })

    const outcomes = await Promise.all([
      captureHireRuntimeMultimodalAnalysis({
        workspaceId: IDS.workspace,
        principalId: IDS.principal,
        capture: capture(),
      }),
      captureHireRuntimeMultimodalAnalysis({
        workspaceId: IDS.workspace,
        principalId: IDS.principal,
        capture: capture(),
      }),
    ])

    expect(outcomes.sort()).toEqual(['accepted', 'already_captured'])
    const uploadedKeys = mocks.uploadLandmark.mock.calls.map(([input]) => input.key)
    expect(uploadedKeys).toHaveLength(1)
    const deletedKey = mocks.deleteObjects.mock.calls[0]?.[0].objects[0].key
    expect(uploadedKeys).not.toContain(deletedKey)
    expect(mocks.deleteObjects).toHaveBeenCalledTimes(1)
    expect(mocks.sessionUpdateOne).not.toHaveBeenCalled()
  })

  it('retains and retries a duplicate-loser obligation when its R2 delete fails', async () => {
    mocks.outboxCreate.mockRejectedValueOnce({ code: 11000 })
    mocks.deleteObjects.mockRejectedValueOnce(new Error('R2 unavailable'))

    await expect(captureHireRuntimeMultimodalAnalysis({
      workspaceId: IDS.workspace,
      principalId: IDS.principal,
      capture: capture(),
    })).rejects.toThrow('R2 unavailable')

    const orphanKey = mocks.deleteObjects.mock.calls[0]?.[0].objects[0].key as string
    const orphanObjectKeyNonce = mocks.deleteObjects.mock.calls[0]?.[0]
      .objects[0].objectKeyNonce as string
    const releasedAfterFailure = mocks.bindingUpdateOne.mock.calls
      .filter(([, , options]) => !options?.session)
      .map(([, update]) => update.$pull?.issuedObjectCapabilities?.key)
      .filter(Boolean)
    expect(releasedAfterFailure).not.toContain(orphanKey)

    const winnerKey = __hireRuntimeMultimodalAnalysisCapture.runtimeLandmarkKey(
      IDS.principal,
      IDS.session,
      '9'.repeat(64),
    )
    mocks.bindingFindOne.mockResolvedValueOnce(binding({
      issuedObjectCapabilities: [{
        key: orphanKey,
        objectKeyNonce: orphanObjectKeyNonce,
        runtimeSessionId: objectId(IDS.session),
        expiresAt: new Date('2026-08-21T00:00:00.000Z'),
      }],
    }))
    mocks.outboxFindOne.mockReturnValueOnce(query({
      landmarkArtifact: { sourceKey: winnerKey },
    }))

    await expect(captureHireRuntimeMultimodalAnalysis({
      workspaceId: IDS.workspace,
      principalId: IDS.principal,
      capture: capture(),
    })).resolves.toBe('already_captured')

    expect(mocks.deleteObjects).toHaveBeenLastCalledWith({
      principalId: IDS.principal,
      objects: [{
        key: orphanKey,
        runtimeSessionId: IDS.session,
        objectKeyNonce: orphanObjectKeyNonce,
      }],
    })
    const release = mocks.bindingUpdateOne.mock.calls.at(-1)
    expect(release?.[0]._id.toString()).toBe(IDS.binding)
    expect(release?.[0].workspaceId.toString()).toBe(IDS.workspace)
    expect(release?.[1].$pull.issuedObjectCapabilities.key).toBe(orphanKey)
    expect(
      release?.[1].$pull.issuedObjectCapabilities.runtimeSessionId.toString(),
    ).toBe(IDS.session)
    expect(mocks.uploadLandmark).not.toHaveBeenCalled()
  })

  it('retains and retries the exact obligation when outbox creation and cleanup both fail', async () => {
    mocks.outboxCreate.mockRejectedValueOnce(new Error('Mongo unavailable'))
    mocks.deleteObjects.mockRejectedValueOnce(new Error('R2 unavailable'))

    await expect(captureHireRuntimeMultimodalAnalysis({
      workspaceId: IDS.workspace,
      principalId: IDS.principal,
      capture: capture(),
    })).rejects.toThrow('R2 unavailable')

    const orphanKey = mocks.deleteObjects.mock.calls[0]?.[0].objects[0].key as string
    const orphanObjectKeyNonce = mocks.deleteObjects.mock.calls[0]?.[0]
      .objects[0].objectKeyNonce as string
    expect(mocks.bindingUpdateOne.mock.calls.some(([, update, options]) =>
      !options?.session &&
      update.$pull?.issuedObjectCapabilities?.key === orphanKey)).toBe(false)

    mocks.bindingFindOne.mockResolvedValueOnce(binding({
      issuedObjectCapabilities: [{
        key: orphanKey,
        objectKeyNonce: orphanObjectKeyNonce,
        runtimeSessionId: objectId(IDS.session),
        expiresAt: new Date('2026-08-21T00:00:00.000Z'),
      }],
    }))
    mocks.outboxFindOne.mockReturnValueOnce(query(null))

    await expect(captureHireRuntimeMultimodalAnalysis({
      workspaceId: IDS.workspace,
      principalId: IDS.principal,
      capture: capture(),
    })).resolves.toBe('accepted')

    const replacementKey = mocks.uploadLandmark.mock.calls[0]?.[0].key as string
    expect(replacementKey).not.toBe(orphanKey)
    expect(mocks.events.indexOf(`delete:${orphanKey}`)).toBeLessThan(
      mocks.events.indexOf(`reserve:${replacementKey}`),
    )
    expect(mocks.bindingUpdateOne.mock.calls.some(([, update]) =>
      update.$pull?.issuedObjectCapabilities?.key === orphanKey)).toBe(true)
    expect(mocks.outboxCreate.mock.calls[1]?.[0]?.[0]).toMatchObject({
      payloadSnapshotProtocolVersion: 1,
      landmarkArtifact: { sourceKey: replacementKey },
    })
  })

  it('keeps the outbox inventory when a post-capture retention delete is not acknowledged by R2', async () => {
    mocks.retentionExists
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    mocks.deleteObjects.mockRejectedValueOnce(new Error('R2 unavailable'))

    await expect(captureHireRuntimeMultimodalAnalysis({
      workspaceId: IDS.workspace,
      principalId: IDS.principal,
      capture: capture(),
    })).rejects.toThrow('R2 unavailable')

    expect(mocks.outboxCreate).toHaveBeenCalledOnce()
    expect(mocks.outboxDeleteMany).not.toHaveBeenCalled()
  })
})
