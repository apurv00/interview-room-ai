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
    mockFindSessions([
      {
        _id: 'session-1',
        recordingR2Key: 'recordings/user/session-camera.webm',
        screenRecordingR2Key: 'recordings/user/session-screen.webm',
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
    expect(mocks.deleteFromR2).toHaveBeenCalledWith('recordings/user/session-camera.webm')
    expect(mocks.deleteFromR2).toHaveBeenCalledWith('recordings/user/session-screen.webm')
    expect(mocks.findByIdAndUpdate).toHaveBeenCalledWith('session-1', {
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
        _id: 'session-1',
        recordingR2Key: 'recordings/user/session-camera.webm',
        screenRecordingR2Key: 'recordings/user/session-screen.webm',
      },
    ])
    mocks.deleteFromR2
      .mockRejectedValueOnce(new Error('delete failed'))
      .mockResolvedValueOnce(undefined)

    const result = await cleanupExpiredReplayRecordings({ retentionDays: 30 })

    expect(mocks.findByIdAndUpdate).toHaveBeenCalledWith('session-1', {
      $unset: {
        screenRecordingR2Key: 1,
        screenRecordingSizeBytes: 1,
      },
    })
    expect(result.keysDeleted).toBe(1)
    expect(result.keysFailed).toBe(1)
    expect(mocks.warn).toHaveBeenCalled()
  })
})
