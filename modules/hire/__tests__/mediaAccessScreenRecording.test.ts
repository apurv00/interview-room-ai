import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  findOne: vi.fn(),
  exists: vi.fn(),
  signDownload: vi.fn(),
}))

vi.mock('../services/hireControlBoundary', () => ({
  connectHireControlDB: mocks.connect,
}))
vi.mock('../models/HireMediaAsset', () => ({
  HireMediaAsset: {
    findOne: mocks.findOne,
    exists: mocks.exists,
  },
}))

import { createHireMediaDownloadCapability } from '../services/mediaAccessService'

const IDS = {
  workspaceId: '1'.repeat(24),
  applicationId: '2'.repeat(24),
  jobId: '3'.repeat(24),
  candidateId: '4'.repeat(24),
  roundId: '5'.repeat(24),
  attemptId: '6'.repeat(24),
  assetId: '7'.repeat(24),
}

function objectId(value: string) {
  return { toString: () => value }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue(undefined)
  mocks.findOne.mockReturnValue({
    select: vi.fn().mockReturnValue({
      lean: async () => ({
        _id: objectId(IDS.assetId),
        workspaceId: objectId(IDS.workspaceId),
        applicationId: objectId(IDS.applicationId),
        jobId: objectId(IDS.jobId),
        candidateId: objectId(IDS.candidateId),
        roundId: objectId(IDS.roundId),
        attemptId: objectId(IDS.attemptId),
        objectKey: 'hire-media/scoped-screen-recording.webm',
        kind: 'screen_recording',
      }),
    }),
  })
  mocks.exists.mockResolvedValue({ _id: objectId(IDS.assetId) })
  mocks.signDownload.mockResolvedValue(
    'https://private-r2.example/screen.webm?signature=temporary',
  )
})

describe('Hire shared-display media access', () => {
  it('mints a short-lived URL only after the complete tenant coordinate survives recheck', async () => {
    const now = new Date('2026-08-20T12:00:00.000Z')
    await expect(
      createHireMediaDownloadCapability({
        workspaceId: IDS.workspaceId,
        applicationId: IDS.applicationId,
        assetId: IDS.assetId,
        now,
        storage: {
          upload: vi.fn(),
          signDownload: mocks.signDownload,
          delete: vi.fn(),
        },
      }),
    ).resolves.toEqual({
      url: 'https://private-r2.example/screen.webm?signature=temporary',
      expiresInSeconds: 300,
      kind: 'screen_recording',
    })

    expect(mocks.signDownload).toHaveBeenCalledWith({
      key: 'hire-media/scoped-screen-recording.webm',
      coordinate: {
        workspaceId: IDS.workspaceId,
        applicationId: IDS.applicationId,
        roundId: IDS.roundId,
        attemptId: IDS.attemptId,
        assetId: IDS.assetId,
      },
      kind: 'screen-recording',
      objectKeyNonce: undefined,
      expiresInSeconds: 300,
    })
    expect(mocks.exists).toHaveBeenCalledWith({
      _id: expect.anything(),
      workspaceId: expect.anything(),
      applicationId: expect.anything(),
      jobId: expect.anything(),
      candidateId: expect.anything(),
      roundId: expect.anything(),
      attemptId: expect.anything(),
      objectKey: 'hire-media/scoped-screen-recording.webm',
      kind: { $ne: 'facial_landmarks' },
      state: 'ready',
      active: true,
      $or: [
        { purgeEligibleAt: { $exists: false } },
        { purgeEligibleAt: { $gt: now } },
      ],
    })
  })
})
