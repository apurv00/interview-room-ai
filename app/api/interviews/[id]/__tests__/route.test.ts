import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  connectDB: vi.fn(),
  getSession: vi.fn(),
  isJobsAccountActive: vi.fn(),
  activeJobsAccountIds: vi.fn(),
  aggregate: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('@shared/services/jobsAccountFence', () => ({
  isJobsAccountActive: mocks.isJobsAccountActive,
  activeJobsAccountIds: mocks.activeJobsAccountIds,
}))
vi.mock('@interview/services/core/interviewService', () => ({
  getSession: mocks.getSession,
  updateSession: vi.fn(),
}))
vi.mock('@learn/services/xpService', () => ({ awardXp: vi.fn() }))
vi.mock('@learn/services/streakService', () => ({ recordActivity: vi.fn(), updateStreak: vi.fn() }))
vi.mock('@learn/services/badgeService', () => ({ checkAndAwardBadges: vi.fn() }))
vi.mock('@shared/services/accountDeletion', () => ({ deleteInterviewSession: vi.fn() }))
vi.mock('@shared/services/usageBuffer', () => ({ flushUsageBuffer: vi.fn() }))
vi.mock('@shared/db/models', () => ({
  InterviewSession: { aggregate: mocks.aggregate },
}))
vi.mock('@shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { GET } from '../route'

const USER_ID = '507f1f77bcf86cd799439010'
const VIEWER_ID = '507f1f77bcf86cd799439011'
const SESSION_ID = '507f1f77bcf86cd799439012'
const ORG_ID = '507f1f77bcf86cd799439013'

function sessionDocument(ownerId = USER_ID) {
  const data = {
    _id: SESSION_ID,
    userId: { toString: () => ownerId },
    organizationId: { toString: () => ORG_ID },
    config: { role: 'backend' },
    feedback: { overall_score: 91, private: 'retained feedback' },
    resumeText: 'PRIVATE RESUME',
    jobDescription: 'PRIVATE JOB DESCRIPTION',
    candidateEmail: 'candidate@example.com',
    userAgent: 'private-agent',
    parsedResume: { name: 'Candidate' },
    parsedJobDescription: { title: 'Backend Engineer' },
    resumeFileName: 'resume.pdf',
    jdFileName: 'job.pdf',
    recordingUrl: 'https://private.example/recording',
    shareToken: 'share-secret',
    recordingR2Key: 'recordings/private.webm',
    screenRecordingR2Key: 'recordings/private-screen.webm',
    audioRecordingR2Key: 'recordings/private-audio.webm',
    facialLandmarksR2Key: 'landmarks/private.json',
    resumeR2Key: 'documents/private-resume.pdf',
    jdR2Key: 'documents/private-job.pdf',
    inviteTokenHash: 'invite-secret',
    inviteTokenExpiry: new Date('2099-01-01T00:00:00.000Z'),
    transcript: [],
  }
  return { ...data, toObject: () => ({ ...data }) }
}

function callRoute(viewerId = USER_ID) {
  mocks.getServerSession.mockResolvedValue({
    user: {
      id: viewerId,
      role: viewerId === USER_ID ? 'candidate' : 'recruiter',
      organizationId: viewerId === USER_ID ? undefined : ORG_ID,
    },
  })
  return GET(
    new NextRequest(`http://localhost/api/interviews/${SESSION_ID}?excludeTranscript=true`),
    { params: { id: SESSION_ID } },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connectDB.mockResolvedValue(undefined)
  mocks.getSession.mockResolvedValue(sessionDocument())
  mocks.isJobsAccountActive.mockResolvedValue(true)
  mocks.activeJobsAccountIds.mockImplementation(
    (userIds: string[]) => Promise.resolve(new Set(userIds)),
  )
  mocks.aggregate.mockResolvedValue([{ hasStoredTranscript: true }])
})

describe('GET /api/interviews/[id] account deletion fence', () => {
  it('rejects a deleting requester before loading retained session data', async () => {
    mocks.isJobsAccountActive.mockResolvedValueOnce(false)

    const response = await callRoute()

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mocks.getSession).not.toHaveBeenCalled()
  })

  it('withholds feedback captured before deletion committed', async () => {
    mocks.activeJobsAccountIds.mockResolvedValueOnce(new Set())

    const response = await callRoute()

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
    expect(mocks.getSession).toHaveBeenCalled()
    expect(mocks.aggregate).toHaveBeenCalled()
    expect(mocks.activeJobsAccountIds).toHaveBeenCalledWith([USER_ID])
  })

  it('hides a retained session from an active organization viewer when its owner is deleting', async () => {
    mocks.getSession.mockResolvedValue(sessionDocument(USER_ID))
    mocks.isJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const response = await callRoute(VIEWER_ID)

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Interview session not found' })
    expect(mocks.getSession).toHaveBeenCalledWith(
      SESSION_ID,
      VIEWER_ID,
      'recruiter',
      ORG_ID,
      { excludeTranscript: true },
    )
  })

  it('withholds data when the owner starts deleting after an organization viewer captured it', async () => {
    mocks.getSession.mockResolvedValue(sessionDocument(USER_ID))
    mocks.activeJobsAccountIds.mockResolvedValueOnce(new Set([VIEWER_ID]))

    const response = await callRoute(VIEWER_ID)

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Interview session not found' })
    expect(mocks.aggregate).toHaveBeenCalled()
    expect(mocks.activeJobsAccountIds).toHaveBeenCalledWith([VIEWER_ID, USER_ID])
  })

  it('preserves an active owner read', async () => {
    const response = await callRoute()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      feedback: { overall_score: 91, private: 'retained feedback' },
      resumeText: 'PRIVATE RESUME',
      jobDescription: 'PRIVATE JOB DESCRIPTION',
      candidateEmail: 'candidate@example.com',
      userAgent: 'private-agent',
      hasRecording: true,
      hasScreenRecording: true,
      hasAudioRecording: true,
    })
    for (const privateField of [
      'recordingR2Key',
      'screenRecordingR2Key',
      'audioRecordingR2Key',
      'facialLandmarksR2Key',
      'resumeR2Key',
      'jdR2Key',
      'inviteTokenHash',
      'inviteTokenExpiry',
    ]) {
      expect(body).not.toHaveProperty(privateField)
    }
    expect(mocks.isJobsAccountActive).toHaveBeenCalledTimes(1)
    expect(mocks.activeJobsAccountIds).toHaveBeenCalledWith([USER_ID])
  })

  it('strips candidate private context from an active organization viewer response', async () => {
    const response = await callRoute(VIEWER_ID)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      feedback: { overall_score: 91, private: 'retained feedback' },
      hasRecording: true,
      hasScreenRecording: true,
      hasAudioRecording: true,
    })
    for (const privateField of [
      'resumeText',
      'jobDescription',
      'candidateEmail',
      'userAgent',
      'parsedResume',
      'parsedJobDescription',
      'resumeFileName',
      'jdFileName',
      'recordingUrl',
      'shareToken',
      'recordingR2Key',
      'screenRecordingR2Key',
      'audioRecordingR2Key',
      'facialLandmarksR2Key',
      'resumeR2Key',
      'jdR2Key',
      'inviteTokenHash',
      'inviteTokenExpiry',
    ]) {
      expect(body).not.toHaveProperty(privateField)
    }
    expect(mocks.activeJobsAccountIds).toHaveBeenCalledWith([VIEWER_ID, USER_ID])
  })

  it('prefers account-unavailable when the session read fails during deletion', async () => {
    mocks.getSession.mockRejectedValue(new Error('session swept'))
    mocks.isJobsAccountActive.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    const response = await callRoute()

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
  })
})
