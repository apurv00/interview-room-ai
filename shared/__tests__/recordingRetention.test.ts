const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(),
  find: vi.fn(),
  findByIdAndUpdate: vi.fn(),
  deleteFromR2: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}))

vi.mock('@shared/db/connection', () => ({
  connectDB: mocks.connectDB,
}))

vi.mock('@shared/db/models/InterviewSession', () => ({
  InterviewSession: {
    find: mocks.find,
    findByIdAndUpdate: mocks.findByIdAndUpdate,
  },
}))

vi.mock('@shared/storage/r2', () => ({
  deleteFromR2: mocks.deleteFromR2,
}))

vi.mock('@shared/logger', () => ({
  aiLogger: {
    warn: mocks.warn,
    info: mocks.info,
  },
}))

import { cleanupExpiredReplayRecordings } from '@shared/services/recordingRetention'

const OWNER_USER_ID = '507f1f77bcf86cd799439010'
const SESSION_ID = '507f1f77bcf86cd799439011'
const FOREIGN_USER_ID = '507f1f77bcf86cd799439012'
const TIMESTAMP = '1721500000000'
const CAMERA_KEY = `recordings/${OWNER_USER_ID}/${SESSION_ID}-${TIMESTAMP}.webm`
const SCREEN_KEY = `recordings/${OWNER_USER_ID}/${SESSION_ID}-screen-${TIMESTAMP}.webm`

function mockFindSessions(sessions: Array<Record<string, unknown>>) {
  const lean = vi.fn().mockResolvedValue(sessions)
  const limit = vi.fn(() => ({ lean }))
  const select = vi.fn(() => ({ limit }))
  mocks.find.mockReturnValue({ select })
  return { select, limit, lean }
}

describe('cleanupExpiredReplayRecordings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.deleteFromR2.mockResolvedValue(undefined)
    mocks.findByIdAndUpdate.mockResolvedValue({})
  })

  it('deletes only replay camera/screen keys and unsets their DB fields', async () => {
    const query = mockFindSessions([
      {
        _id: SESSION_ID,
        userId: OWNER_USER_ID,
        recordingR2Key: CAMERA_KEY,
        screenRecordingR2Key: SCREEN_KEY,
      },
    ])

    const result = await cleanupExpiredReplayRecordings({
      retentionDays: 30,
      now: new Date('2026-05-09T00:00:00.000Z'),
    })

    expect(mocks.find).toHaveBeenCalledWith({
      status: 'completed',
      completedAt: { $lte: new Date('2026-04-09T00:00:00.000Z') },
      $or: [
        { recordingR2Key: { $exists: true, $ne: null } },
        { screenRecordingR2Key: { $exists: true, $ne: null } },
      ],
    })
    expect(query.select).toHaveBeenCalledWith(
      '_id userId recordingR2Key screenRecordingR2Key',
    )
    const authority = { ownerUserId: OWNER_USER_ID, sessionId: SESSION_ID }
    expect(mocks.deleteFromR2).toHaveBeenCalledWith(CAMERA_KEY, authority)
    expect(mocks.deleteFromR2).toHaveBeenCalledWith(SCREEN_KEY, authority)
    expect(mocks.findByIdAndUpdate).toHaveBeenCalledWith(SESSION_ID, {
      $unset: {
        recordingR2Key: 1,
        recordingSizeBytes: 1,
        screenRecordingR2Key: 1,
        screenRecordingSizeBytes: 1,
      },
    })
    expect(result).toMatchObject({
      scanned: 1,
      sessionsUpdated: 1,
      keysDeleted: 2,
      keysFailed: 0,
    })
  })

  it('keeps DB fields for keys that fail to delete', async () => {
    mockFindSessions([
      {
        _id: SESSION_ID,
        userId: OWNER_USER_ID,
        recordingR2Key: CAMERA_KEY,
        screenRecordingR2Key: SCREEN_KEY,
      },
    ])
    mocks.deleteFromR2
      .mockRejectedValueOnce(new Error('delete failed'))
      .mockResolvedValueOnce(undefined)

    const result = await cleanupExpiredReplayRecordings({ retentionDays: 30 })

    expect(mocks.deleteFromR2).toHaveBeenNthCalledWith(1, CAMERA_KEY, {
      ownerUserId: OWNER_USER_ID,
      sessionId: SESSION_ID,
    })
    expect(mocks.deleteFromR2).toHaveBeenNthCalledWith(2, SCREEN_KEY, {
      ownerUserId: OWNER_USER_ID,
      sessionId: SESSION_ID,
    })
    expect(mocks.findByIdAndUpdate).toHaveBeenCalledWith(SESSION_ID, {
      $unset: {
        screenRecordingR2Key: 1,
        screenRecordingSizeBytes: 1,
      },
    })
    expect(result.keysDeleted).toBe(1)
    expect(result.keysFailed).toBe(1)
    expect(mocks.warn).toHaveBeenCalled()
  })

  it('fails a foreign stored key closed without clearing or counting it as deleted', async () => {
    const poisonedKey = `recordings/${FOREIGN_USER_ID}/${SESSION_ID}-${TIMESTAMP}.webm`
    mockFindSessions([
      {
        _id: SESSION_ID,
        userId: OWNER_USER_ID,
        recordingR2Key: poisonedKey,
      },
    ])
    mocks.deleteFromR2.mockRejectedValueOnce(
      new Error('R2 key is outside the authorized deletion scope'),
    )

    const result = await cleanupExpiredReplayRecordings({ retentionDays: 30 })

    expect(mocks.deleteFromR2).toHaveBeenCalledWith(poisonedKey, {
      ownerUserId: OWNER_USER_ID,
      sessionId: SESSION_ID,
    })
    expect(mocks.findByIdAndUpdate).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      scanned: 1,
      sessionsUpdated: 0,
      keysDeleted: 0,
      keysFailed: 1,
    })
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ key: poisonedKey, sessionId: SESSION_ID }),
      'Failed to delete expired replay recording',
    )
  })
})
