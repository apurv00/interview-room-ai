import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(),
  analysisFind: vi.fn(),
  analysisFindByIdAndDelete: vi.fn(),
  sessionFindOne: vi.fn(),
  sessionLean: vi.fn(),
  sessionUpdateOne: vi.fn(),
  deleteFromR2: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}))

vi.mock('@shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('@shared/db/models/MultimodalAnalysis', () => ({
  MultimodalAnalysis: {
    find: (...args: unknown[]) => mocks.analysisFind(...args),
    findByIdAndDelete: (...args: unknown[]) => mocks.analysisFindByIdAndDelete(...args),
  },
}))
vi.mock('@shared/db/models/InterviewSession', () => ({
  InterviewSession: {
    findOne: (...args: unknown[]) => mocks.sessionFindOne(...args),
    updateOne: (...args: unknown[]) => mocks.sessionUpdateOne(...args),
  },
}))
vi.mock('@shared/storage/r2', () => ({
  deleteFromR2: (...args: unknown[]) => mocks.deleteFromR2(...args),
}))
vi.mock('@shared/logger', () => ({
  aiLogger: {
    warn: mocks.warn,
    info: mocks.info,
    error: mocks.error,
  },
}))

import { enforceAnalysisCap } from '@shared/services/analysisCleanup'

const OWNER_USER_ID = '507f1f77bcf86cd799439010'
const SESSION_ID = '507f1f77bcf86cd799439011'
const FOREIGN_SESSION_ID = '507f1f77bcf86cd799439012'
const ANALYSIS_ID = '507f1f77bcf86cd799439013'
const TIMESTAMP = '1721500000000'
const CAMERA_KEY = `recordings/${OWNER_USER_ID}/${SESSION_ID}-${TIMESTAMP}.webm`
const LANDMARKS_KEY = `landmarks/${OWNER_USER_ID}/${SESSION_ID}.json`

function mockAnalyses(analyses: Array<Record<string, unknown>>) {
  const lean = vi.fn().mockResolvedValue(analyses)
  const sort = vi.fn(() => ({ lean }))
  mocks.analysisFind.mockReturnValue({ sort })
  return { sort, lean }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connectDB.mockResolvedValue(undefined)
  mocks.analysisFindByIdAndDelete.mockResolvedValue({ _id: ANALYSIS_ID })
  mocks.sessionFindOne.mockReturnValue({ lean: mocks.sessionLean })
  mocks.sessionUpdateOne.mockResolvedValue({ modifiedCount: 1 })
  mocks.deleteFromR2.mockResolvedValue(undefined)
})

describe('enforceAnalysisCap R2 deletion authority', () => {
  it('binds each delete and exact-key unset to the analysis owner and session', async () => {
    mockAnalyses([{ _id: ANALYSIS_ID, sessionId: SESSION_ID }])
    mocks.sessionLean.mockResolvedValue({
      _id: SESSION_ID,
      userId: OWNER_USER_ID,
      recordingR2Key: CAMERA_KEY,
      facialLandmarksR2Key: LANDMARKS_KEY,
      multimodalAnalysisId: ANALYSIS_ID,
    })

    const result = await enforceAnalysisCap(OWNER_USER_ID, 0)

    expect(mocks.sessionFindOne).toHaveBeenCalledWith({
      _id: SESSION_ID,
      userId: OWNER_USER_ID,
    })
    const authority = { ownerUserId: OWNER_USER_ID, sessionId: SESSION_ID }
    expect(mocks.deleteFromR2).toHaveBeenCalledWith(CAMERA_KEY, authority)
    expect(mocks.deleteFromR2).toHaveBeenCalledWith(LANDMARKS_KEY, authority)
    expect(mocks.sessionUpdateOne).toHaveBeenCalledWith(
      {
        _id: SESSION_ID,
        userId: OWNER_USER_ID,
        recordingR2Key: CAMERA_KEY,
      },
      { $unset: { recordingR2Key: 1, recordingDurationSeconds: 1 } },
    )
    expect(mocks.sessionUpdateOne).toHaveBeenCalledWith(
      {
        _id: SESSION_ID,
        userId: OWNER_USER_ID,
        facialLandmarksR2Key: LANDMARKS_KEY,
      },
      { $unset: { facialLandmarksR2Key: 1 } },
    )
    expect(mocks.sessionUpdateOne).toHaveBeenCalledWith(
      {
        _id: SESSION_ID,
        userId: OWNER_USER_ID,
        multimodalAnalysisId: ANALYSIS_ID,
      },
      { $unset: { multimodalAnalysisId: 1 } },
    )
    expect(mocks.analysisFindByIdAndDelete).toHaveBeenCalledWith(ANALYSIS_ID)
    expect(result).toEqual({ deleted: 1 })
  })

  it('retains poisoned-key fields and the analysis as retry inventory', async () => {
    const poisonedKey = `recordings/${OWNER_USER_ID}/${FOREIGN_SESSION_ID}-screen-${TIMESTAMP}.webm`
    mockAnalyses([{ _id: ANALYSIS_ID, sessionId: SESSION_ID }])
    mocks.sessionLean.mockResolvedValue({
      _id: SESSION_ID,
      userId: OWNER_USER_ID,
      recordingR2Key: CAMERA_KEY,
      screenRecordingR2Key: poisonedKey,
      multimodalAnalysisId: ANALYSIS_ID,
    })
    mocks.deleteFromR2.mockImplementation(async (key: string) => {
      if (key === poisonedKey) {
        throw new Error('R2 key is outside the authorized deletion scope')
      }
    })

    const result = await enforceAnalysisCap(OWNER_USER_ID, 0)

    const authority = { ownerUserId: OWNER_USER_ID, sessionId: SESSION_ID }
    expect(mocks.deleteFromR2).toHaveBeenCalledWith(CAMERA_KEY, authority)
    expect(mocks.deleteFromR2).toHaveBeenCalledWith(poisonedKey, authority)
    expect(mocks.sessionUpdateOne).toHaveBeenCalledTimes(1)
    expect(mocks.sessionUpdateOne).toHaveBeenCalledWith(
      {
        _id: SESSION_ID,
        userId: OWNER_USER_ID,
        recordingR2Key: CAMERA_KEY,
      },
      { $unset: { recordingR2Key: 1, recordingDurationSeconds: 1 } },
    )
    expect(mocks.analysisFindByIdAndDelete).not.toHaveBeenCalled()
    expect(result).toEqual({ deleted: 0 })
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ key: poisonedKey, sessionId: SESSION_ID }),
      'Failed to delete R2 object during analysis cap cleanup',
    )
  })
})
