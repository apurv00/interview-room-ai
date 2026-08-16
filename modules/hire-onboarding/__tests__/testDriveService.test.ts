import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const IDS = {
  workspace: '1'.repeat(24),
  member: '2'.repeat(24),
  job: '3'.repeat(24),
  candidate: '4'.repeat(24),
  application: '5'.repeat(24),
  round: '6'.repeat(24),
  testDrive: '7'.repeat(24),
}
const OPERATION_ID = '11111111-1111-4111-8111-111111111111'
const INVITE_URL = 'https://hire.example/interview/round#invite=one-time-practice-capability'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  transaction: vi.fn(),
  applicationCreate: vi.fn(),
  candidateCreate: vi.fn(),
  candidateExists: vi.fn(),
  jobCreate: vi.fn(),
  requirementCreate: vi.fn(),
  roundFindOne: vi.fn(),
  sendRound: vi.fn(),
  revokeRound: vi.fn(),
  kickCleanup: vi.fn(),
  testDriveFindOne: vi.fn(),
  testDriveCreate: vi.fn(),
  testDriveFindOneAndUpdate: vi.fn(),
  ensureSystemDepartment: vi.fn(),
}))

vi.mock('@hire-onboarding-boundary', () => ({
  connectHireControlDB: mocks.connect,
  withActiveHireWorkspaceWriteTransaction: mocks.transaction,
  HireApplication: { create: mocks.applicationCreate },
  HireCandidate: { create: mocks.candidateCreate, exists: mocks.candidateExists },
  HireJob: { create: mocks.jobCreate },
  HireJobRequirementVersion: { create: mocks.requirementCreate },
  HireRound: { findOne: mocks.roundFindOne },
  sendAiRound: mocks.sendRound,
  revokeRound: mocks.revokeRound,
}))
vi.mock('../models', () => ({
  HireOnboardingTestDrive: {
    findOne: mocks.testDriveFindOne,
    create: mocks.testDriveCreate,
    findOneAndUpdate: mocks.testDriveFindOneAndUpdate,
  },
  HIRE_ONBOARDING_TEST_DRIVE_COLLECTION: 'hireonboardingtestdrives',
}))
vi.mock('../services/testDriveLifecycleService', () => ({
  kickHireOnboardingTestDriveCleanup: (...args: unknown[]) => mocks.kickCleanup(...args),
}))
vi.mock('@hire-departments', () => ({
  ensureHireSystemDepartment: (...args: unknown[]) => mocks.ensureSystemDepartment(...args),
}))

import {
  buildHireOnboardingTestDriveExclusionStages,
  getHireOnboardingTestDrive,
  removeHireOnboardingTestDrive,
  startHireOnboardingTestDrive,
  toHireOnboardingTestDriveAuditView,
} from '../services/testDriveService'

function query<T>(value: T) {
  const promise = Promise.resolve(value)
  return {
    session: vi.fn().mockResolvedValue(value),
    sort: vi.fn().mockResolvedValue(value),
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
  }
}

function objectId(value: string) {
  return { toString: () => value }
}

function testDrive(overrides: Record<string, unknown> = {}) {
  return {
    _id: objectId(IDS.testDrive),
    workspaceId: objectId(IDS.workspace),
    issuedByMemberId: objectId(IDS.member),
    issuedByName: 'Hiring manager',
    operationId: OPERATION_ID,
    label: 'Interview yourself' as const,
    state: 'provisioning' as const,
    active: true,
    excludeFromAggregates: true as const,
    jobId: objectId(IDS.job),
    candidateId: objectId(IDS.candidate),
    applicationId: objectId(IDS.application),
    cleanupAfter: new Date('2099-08-28T00:00:00.000Z'),
    createdAt: new Date('2099-08-14T00:00:00.000Z'),
    ...overrides,
  }
}

const context = {
  workspace: { _id: objectId(IDS.workspace), name: 'Acme', guestAuthMode: 'magic_link' },
  membership: { _id: objectId(IDS.member), name: 'Hiring manager', email: 'hr@example.com' },
} as any

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue(undefined)
  mocks.transaction.mockImplementation(
    async (_workspace: unknown, _member: unknown, work: (session: object) => unknown) => work({}),
  )
  mocks.applicationCreate.mockResolvedValue([])
  mocks.candidateCreate.mockResolvedValue([])
  mocks.candidateExists.mockReturnValue(query(null))
  mocks.jobCreate.mockResolvedValue([])
  mocks.requirementCreate.mockResolvedValue([])
  mocks.roundFindOne.mockReturnValue(query(null))
  mocks.sendRound.mockResolvedValue({
    round: { _id: objectId(IDS.round) },
    inviteUrl: INVITE_URL,
    emailSent: true,
  })
  mocks.revokeRound.mockResolvedValue(undefined)
  mocks.kickCleanup.mockResolvedValue(true)
  mocks.ensureSystemDepartment.mockResolvedValue({ _id: objectId('8'.repeat(24)) })
  mocks.testDriveFindOne.mockReturnValue(query(null))
  mocks.testDriveCreate.mockImplementation(async (rows: Record<string, unknown>[]) => [
    testDrive(rows[0]),
  ])
  mocks.testDriveFindOneAndUpdate.mockImplementation(async (_filter: unknown, update: any) =>
    testDrive({ ...update.$set, roundId: update.$set.roundId ?? objectId(IDS.round) }),
  )
})

describe('Hire onboarding test-drive service', () => {
  it('creates a clearly labelled isolated graph and gives the original request one raw invite URL', async () => {
    const result = await startHireOnboardingTestDrive(context, { operationId: OPERATION_ID })

    expect(result).toMatchObject({
      created: true,
      inviteUrl: INVITE_URL,
      emailSent: true,
      testDrive: {
        label: 'Interview yourself',
        jobId: IDS.job,
        candidateId: IDS.candidate,
        applicationId: IDS.application,
        roundId: IDS.round,
      },
    })
    expect(mocks.candidateExists).toHaveBeenCalledWith({
      workspaceId: context.workspace._id,
      email: 'hr@example.com',
    })
    expect(mocks.candidateCreate.mock.calls[0]?.[0]?.[0]).toMatchObject({
      name: expect.stringContaining('Practice candidate'),
      email: 'hr@example.com',
      source: 'manual',
      createdByMemberId: context.membership._id,
    })
    const practiceJob = mocks.jobCreate.mock.calls[0]?.[0]?.[0]
    expect(practiceJob).toMatchObject({
      departmentId: expect.anything(),
      title: expect.stringContaining('Practice interview'),
      status: 'open',
      activeRequirementVersion: 1,
    })
    expect(practiceJob.departmentId.toString()).toBe('8'.repeat(24))
    expect(mocks.ensureSystemDepartment).toHaveBeenCalledWith({
      workspaceId: context.workspace._id,
      kind: 'onboarding',
      session: {},
    })
    expect(mocks.applicationCreate.mock.calls[0]?.[0]?.[0]).toMatchObject({
      events: [
        expect.objectContaining({
          type: 'created',
          note: expect.stringContaining('excluded from operations'),
          operationId: OPERATION_ID,
        }),
      ],
    })
    const durableRecord = mocks.testDriveCreate.mock.calls[0]?.[0]?.[0]
    expect(durableRecord).toMatchObject({
      issuedByMemberId: context.membership._id,
      issuedByName: 'Hiring manager',
      excludeFromAggregates: true,
      active: true,
    })
    expect(JSON.stringify(durableRecord)).not.toContain('one-time-practice-capability')
    expect(mocks.sendRound).toHaveBeenCalledWith(context, {
      applicationId: durableRecord.applicationId.toString(),
      experience: '3-6',
      duration: 10,
    })
  })

  it('never merges into a current member email that already belongs to a candidate', async () => {
    mocks.candidateExists.mockReturnValue(query({ _id: objectId('8'.repeat(24)) }))

    await expect(
      startHireOnboardingTestDrive(context, { operationId: OPERATION_ID }),
    ).rejects.toMatchObject({ code: 'TEST_DRIVE_MEMBER_EMAIL_ALREADY_EXISTS' })
    expect(mocks.candidateCreate).not.toHaveBeenCalled()
    expect(mocks.applicationCreate).not.toHaveBeenCalled()
    expect(mocks.sendRound).not.toHaveBeenCalled()
  })

  it('returns no raw capability for an idempotent operation retry', async () => {
    const existing = testDrive({ state: 'ready', roundId: objectId(IDS.round) })
    mocks.testDriveFindOne.mockReturnValueOnce(query(existing))
    mocks.roundFindOne.mockReturnValueOnce(query({ _id: objectId(IDS.round) }))

    await expect(
      startHireOnboardingTestDrive(context, { operationId: OPERATION_ID }),
    ).resolves.toMatchObject({
      created: false,
      inviteUrl: null,
      testDrive: { id: IDS.testDrive, roundId: IDS.round },
    })
    expect(mocks.sendRound).not.toHaveBeenCalled()
  })

  it('can finish a provisioning retry but discards the raw capability returned by the normal AI round flow', async () => {
    const existing = testDrive({ state: 'provisioning' })
    mocks.testDriveFindOne.mockReturnValueOnce(query(existing))
    mocks.roundFindOne.mockReturnValueOnce(query(null))

    await expect(
      startHireOnboardingTestDrive(context, { operationId: OPERATION_ID }),
    ).resolves.toMatchObject({
      created: false,
      inviteUrl: null,
      testDrive: { roundId: IDS.round, state: 'ready' },
    })
    expect(mocks.sendRound).toHaveBeenCalledOnce()
  })

  it('returns only safe caller-owned state and preserves opaque audit actor snapshots', async () => {
    const ready = testDrive({
      state: 'ready',
      roundId: objectId(IDS.round),
      removedAt: new Date('2099-08-16T00:00:00.000Z'),
      removedByMemberId: objectId(IDS.member),
      removedByName: 'Hiring manager',
    })
    mocks.testDriveFindOne.mockReturnValueOnce(query(ready))

    await expect(getHireOnboardingTestDrive(context)).resolves.toEqual({
      id: IDS.testDrive,
      label: 'Interview yourself',
      state: 'ready',
      jobId: IDS.job,
      candidateId: IDS.candidate,
      applicationId: IDS.application,
      roundId: IDS.round,
      issuedAt: new Date('2099-08-14T00:00:00.000Z'),
      cleanupAfter: new Date('2099-08-28T00:00:00.000Z'),
      removedAt: new Date('2099-08-16T00:00:00.000Z'),
    })
    expect(toHireOnboardingTestDriveAuditView(ready as any)).toMatchObject({
      issuedByMemberId: IDS.member,
      issuedByName: 'Hiring manager',
      removedByMemberId: IDS.member,
      removedByName: 'Hiring manager',
    })
    expect(JSON.stringify(toHireOnboardingTestDriveAuditView(ready as any))).not.toMatch(
      /invite|token|secret|email/i,
    )
  })

  it('revokes an active practice round through the established Hire command and retains the exclusion marker', async () => {
    const ready = testDrive({ state: 'ready', roundId: objectId(IDS.round) })
    mocks.testDriveFindOne.mockReturnValueOnce(query(ready))
    mocks.roundFindOne.mockReturnValueOnce(
      query({ _id: objectId(IDS.round), status: 'invited', revokedAt: null }),
    )

    await expect(removeHireOnboardingTestDrive(context)).resolves.toMatchObject({
      id: IDS.testDrive,
      state: 'removed',
    })
    expect(mocks.revokeRound).toHaveBeenCalledWith(context, IDS.round)
    expect(mocks.testDriveFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ issuedByMemberId: context.membership._id, active: true }),
      expect.objectContaining({
        $set: expect.objectContaining({
          state: 'removed',
          active: false,
          removedByMemberId: context.membership._id,
        }),
      }),
      expect.anything(),
    )
    expect(mocks.kickCleanup).toHaveBeenCalledWith({
      workspaceId: IDS.workspace,
      testDriveId: IDS.testDrive,
    })
    expect(mocks.testDriveFindOneAndUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.kickCleanup.mock.invocationCallOrder[0],
    )
  })

  it('builds an explicit workspace-scoped lookup for every aggregate coordinate', () => {
    for (const coordinate of ['applicationId', 'jobId', 'candidateId', 'roundId'] as const) {
      const stages = buildHireOnboardingTestDriveExclusionStages({ coordinate })
      expect(stages).toHaveLength(3)
      expect(stages[0]).toEqual(
        expect.objectContaining({
          $lookup: expect.objectContaining({
            from: 'hireonboardingtestdrives',
            let: expect.objectContaining({
              testDriveWorkspaceId: '$workspaceId',
              testDriveCoordinateId: '$_id',
            }),
          }),
        }),
      )
      expect(JSON.stringify(stages)).toContain(`$${coordinate}`)
      expect(JSON.stringify(stages)).toContain('excludeFromAggregates')
    }
  })

  it('does not import the Hire root, B2C, or an engine/runtime implementation directly', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'modules/hire-onboarding/services/testDriveService.ts'),
      'utf8',
    )
    expect(source).toContain("from '@hire-onboarding-boundary'")
    expect(source).not.toMatch(/from ['"]@hire['"]/)
    expect(source).not.toMatch(/from ['"][^'"]*(?:b2c|engine|runtime)[^'"]*['"]/i)
  })
})
