import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  mongoSession: { id: 'recording-artifact-transaction' },
  withActiveJobsAccountWrite: vi.fn(),
  findOne: vi.fn(),
  updateOne: vi.fn(),
  deleteFromR2: vi.fn(),
  loggerWarn: vi.fn(),
}))

vi.mock('@shared/services/jobsAccountFence', () => ({
  withActiveJobsAccountWrite: mocks.withActiveJobsAccountWrite,
}))

vi.mock('@shared/db/models/InterviewSession', () => ({
  InterviewSession: {
    findOne: mocks.findOne,
    updateOne: mocks.updateOne,
  },
}))

vi.mock('@shared/storage/r2', () => ({
  deleteFromR2: mocks.deleteFromR2,
}))

vi.mock('@shared/logger', () => ({
  aiLogger: { warn: mocks.loggerWarn },
}))

import {
  associateRecordingArtifact,
  cleanupSupersededRecordingArtifact,
  isSessionRecordingKey,
  parseRecordingArtifactKey,
  RecordingArtifactKeyRejectedError,
  RecordingArtifactSessionNotFoundError,
} from '../recordingArtifactService'

const USER_ID = '507f1f77bcf86cd799439010'
const FOREIGN_USER_ID = '507f1f77bcf86cd799439011'
const SESSION_ID = '507f1f77bcf86cd799439012'
const FOREIGN_SESSION_ID = '507f1f77bcf86cd799439013'
const OLDER_TIMESTAMP = '1700000000000'
const NEWER_TIMESTAMP = '1700000000001'
const DELETE_AUTHORITY = {
  ownerUserId: USER_ID,
  sessionId: SESSION_ID,
}

function keyFor(
  type: 'recording' | 'screen-recording' | 'audio-recording',
  timestamp = OLDER_TIMESTAMP,
  userId = USER_ID,
  sessionId = SESSION_ID,
) {
  const suffix = type === 'screen-recording'
    ? '-screen'
    : type === 'audio-recording'
    ? '-audio'
    : ''
  return `recordings/${userId}/${sessionId}${suffix}-${timestamp}.webm`
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.withActiveJobsAccountWrite.mockImplementation(
    async (_userId: string, work: (session: unknown) => Promise<unknown>) => {
      return work(mocks.mongoSession)
    },
  )
  mocks.findOne.mockResolvedValue({})
  mocks.updateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.deleteFromR2.mockResolvedValue(undefined)
})

describe('recording artifact key identity', () => {
  it.each([
    ['recording', keyFor('recording'), 'recording'],
    ['screen recording', keyFor('screen-recording'), 'screen-recording'],
    ['audio recording', keyFor('audio-recording'), 'audio-recording'],
  ] as const)('parses a canonical %s key without recomputing its timestamp', (_label, key, type) => {
    expect(parseRecordingArtifactKey(key, USER_ID)).toEqual({
      sessionId: SESSION_ID,
      type,
      timestamp: OLDER_TIMESTAMP,
    })
  })

  it.each([
    ['foreign user', keyFor('recording', OLDER_TIMESTAMP, FOREIGN_USER_ID)],
    ['foreign session', keyFor('recording', OLDER_TIMESTAMP, USER_ID, FOREIGN_SESSION_ID)],
    ['wrong artifact type', keyFor('screen-recording')],
    ['short timestamp', keyFor('recording', '123456789')],
    ['non-numeric timestamp', keyFor('recording', '170000000000x')],
    ['timestamp suffix', `${keyFor('recording')}.bak`],
    ['path traversal', `recordings/${USER_ID}/../${SESSION_ID}-${OLDER_TIMESTAMP}.webm`],
    ['arbitrary object', `recordings/${USER_ID}/not-a-recording.webm`],
  ])('rejects a %s key for this camera recording', (_label, key) => {
    expect(isSessionRecordingKey(key, 'recording', USER_ID, SESSION_ID)).toBe(false)
  })

  it('rejects a canonical key whose declared type does not match its identity', async () => {
    await expect(associateRecordingArtifact({
      userId: USER_ID,
      sessionId: SESSION_ID,
      type: 'recording',
      key: keyFor('audio-recording'),
      sizeBytes: 123,
    })).rejects.toBeInstanceOf(RecordingArtifactKeyRejectedError)

    expect(mocks.withActiveJobsAccountWrite).not.toHaveBeenCalled()
    expect(mocks.findOne).not.toHaveBeenCalled()
  })
})

describe('associateRecordingArtifact', () => {
  it('reads and updates the owned session inside the active-account transaction', async () => {
    const key = keyFor('recording')

    await expect(associateRecordingArtifact({
      userId: USER_ID,
      sessionId: SESSION_ID,
      type: 'recording',
      key,
      sizeBytes: 4_096,
      durationSeconds: 87.5,
    })).resolves.toEqual({ accepted: true, previousKey: undefined })

    expect(mocks.withActiveJobsAccountWrite).toHaveBeenCalledWith(
      USER_ID,
      expect.any(Function),
    )
    expect(mocks.findOne).toHaveBeenCalledWith(
      { _id: SESSION_ID, userId: USER_ID },
      { recordingR2Key: 1 },
      { session: mocks.mongoSession },
    )
    expect(mocks.updateOne).toHaveBeenCalledWith(
      { _id: SESSION_ID, userId: USER_ID },
      {
        $set: {
          recordingR2Key: key,
          recordingSizeBytes: 4_096,
          recordingDurationSeconds: 87.5,
        },
        $inc: { recordingArtifactVersion: 1 },
      },
      { session: mocks.mongoSession },
    )
  })

  it.each([
    [
      'screen-recording',
      'screenRecordingR2Key',
      'screenRecordingSizeBytes',
      'screenRecordingArtifactVersion',
    ],
    ['audio-recording', 'audioRecordingR2Key', 'audioRecordingSizeBytes', null],
  ] as const)('associates %s with only its type-specific fields', async (
    type,
    keyField,
    sizeField,
    versionField,
  ) => {
    const key = keyFor(type)

    await associateRecordingArtifact({
      userId: USER_ID,
      sessionId: SESSION_ID,
      type,
      key,
      sizeBytes: 512,
    })

    expect(mocks.findOne).toHaveBeenCalledWith(
      { _id: SESSION_ID, userId: USER_ID },
      { [keyField]: 1 },
      { session: mocks.mongoSession },
    )
    expect(mocks.updateOne).toHaveBeenCalledWith(
      { _id: SESSION_ID, userId: USER_ID },
      {
        $set: { [keyField]: key, [sizeField]: 512 },
        ...(versionField ? { $inc: { [versionField]: 1 } } : {}),
      },
      { session: mocks.mongoSession },
    )
  })

  it('rejects an absent or foreign session before attempting an update', async () => {
    mocks.findOne.mockResolvedValueOnce(null)

    await expect(associateRecordingArtifact({
      userId: USER_ID,
      sessionId: SESSION_ID,
      type: 'recording',
      key: keyFor('recording'),
      sizeBytes: 123,
    })).rejects.toBeInstanceOf(RecordingArtifactSessionNotFoundError)

    expect(mocks.updateOne).not.toHaveBeenCalled()
  })

  it('rejects a session removed between the transactional read and update', async () => {
    mocks.updateOne.mockResolvedValueOnce({ matchedCount: 0 })

    await expect(associateRecordingArtifact({
      userId: USER_ID,
      sessionId: SESSION_ID,
      type: 'recording',
      key: keyFor('recording'),
      sizeBytes: 123,
    })).rejects.toBeInstanceOf(RecordingArtifactSessionNotFoundError)
  })

  it('does not let delayed older upload A replace already-associated newer upload B', async () => {
    const olderKey = keyFor('recording', OLDER_TIMESTAMP)
    const newerKey = keyFor('recording', NEWER_TIMESTAMP)
    mocks.findOne.mockResolvedValueOnce({ recordingR2Key: newerKey })

    await expect(associateRecordingArtifact({
      userId: USER_ID,
      sessionId: SESSION_ID,
      type: 'recording',
      key: olderKey,
      sizeBytes: 123,
    })).resolves.toEqual({ accepted: false, previousKey: undefined })

    expect(mocks.updateOne).not.toHaveBeenCalled()
  })

  it('accepts newer upload B and returns older upload A for cleanup', async () => {
    const olderKey = keyFor('recording', OLDER_TIMESTAMP)
    const newerKey = keyFor('recording', NEWER_TIMESTAMP)
    mocks.findOne.mockResolvedValueOnce({ recordingR2Key: olderKey })

    await expect(associateRecordingArtifact({
      userId: USER_ID,
      sessionId: SESSION_ID,
      type: 'recording',
      key: newerKey,
      sizeBytes: 456,
    })).resolves.toEqual({ accepted: true, previousKey: olderKey })

    expect(mocks.updateOne).toHaveBeenCalledTimes(1)
  })
})

describe('cleanupSupersededRecordingArtifact', () => {
  it('deletes a superseded object after its replacement is associated', async () => {
    const olderKey = keyFor('recording', OLDER_TIMESTAMP)
    const newerKey = keyFor('recording', NEWER_TIMESTAMP)

    await cleanupSupersededRecordingArtifact(
      olderKey,
      newerKey,
      USER_ID,
      SESSION_ID,
    )

    expect(mocks.deleteFromR2).toHaveBeenCalledWith(olderKey, DELETE_AUTHORITY)
  })

  it.each([undefined, keyFor('recording')])(
    'does not delete when there is no distinct superseded object (%s)',
    async (previousKey) => {
      const replacementKey = keyFor('recording')

      await cleanupSupersededRecordingArtifact(
        previousKey,
        replacementKey,
        USER_ID,
        SESSION_ID,
      )

      expect(mocks.deleteFromR2).not.toHaveBeenCalled()
    },
  )

  it('keeps a successful association non-fatal and logs failed cleanup', async () => {
    const error = new Error('R2 unavailable')
    const olderKey = keyFor('recording', OLDER_TIMESTAMP)
    const newerKey = keyFor('recording', NEWER_TIMESTAMP)
    mocks.deleteFromR2.mockRejectedValueOnce(error)

    await expect(
      cleanupSupersededRecordingArtifact(
        olderKey,
        newerKey,
        USER_ID,
        SESSION_ID,
      ),
    ).resolves.toBeUndefined()
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      { error, previousKey: olderKey, replacementKey: newerKey },
      'Failed to delete superseded replay recording',
    )
  })

  it('keeps a poisoned foreign-owner previous key non-fatal and warning-only', async () => {
    const poisonedPreviousKey = keyFor(
      'recording',
      OLDER_TIMESTAMP,
      FOREIGN_USER_ID,
    )
    const replacementKey = keyFor('recording', NEWER_TIMESTAMP)
    const authorityError = Object.assign(
      new Error('R2 key is outside the authorized deletion scope'),
      { name: 'R2DeleteAuthorityError', key: poisonedPreviousKey },
    )
    mocks.deleteFromR2.mockRejectedValueOnce(authorityError)

    await expect(cleanupSupersededRecordingArtifact(
      poisonedPreviousKey,
      replacementKey,
      USER_ID,
      SESSION_ID,
    )).resolves.toBeUndefined()

    expect(mocks.deleteFromR2).toHaveBeenCalledWith(
      poisonedPreviousKey,
      DELETE_AUTHORITY,
    )
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      {
        error: authorityError,
        previousKey: poisonedPreviousKey,
        replacementKey,
      },
      'Failed to delete superseded replay recording',
    )
  })
})
