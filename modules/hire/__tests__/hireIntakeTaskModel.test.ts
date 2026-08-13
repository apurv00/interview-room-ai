import mongoose, { type Model } from 'mongoose'
import { describe, expect, it } from 'vitest'
import {
  HireIntakeTask,
  HIRE_INTAKE_TASK_MAX_PAYLOAD_BYTES,
  HIRE_INTAKE_TASK_SOURCES,
  HIRE_INTAKE_TASK_STATUSES,
} from '../models/HireIntakeTask'

const WORKSPACE_ID = new mongoose.Types.ObjectId('111111111111111111111111')
const JOB_ID = new mongoose.Types.ObjectId('222222222222222222222222')
const MEMBER_ID = new mongoose.Types.ObjectId('333333333333333333333333')
const CANDIDATE_ID = new mongoose.Types.ObjectId('444444444444444444444444')
const APPLICATION_ID = new mongoose.Types.ObjectId('555555555555555555555555')
const APPLY_TOKEN_HASH = 'a'.repeat(64)

function intakeTaskInput(overrides: Record<string, unknown> = {}) {
  const payload = Buffer.from('resume bytes')
  return {
    workspaceId: WORKSPACE_ID,
    jobId: JOB_ID,
    source: 'bulk_upload',
    originalFileName: 'Ada-Lovelace.pdf',
    originalContentType: 'application/pdf',
    originalFileSizeBytes: payload.length,
    payload,
    actorMemberId: MEMBER_ID,
    actorName: 'Ada Recruiter',
    ...overrides,
  }
}

function indexes(model: Model<never>): Array<[Record<string, number>, Record<string, unknown>]> {
  return model.schema.indexes() as Array<[Record<string, number>, Record<string, unknown>]>
}

describe('HireIntakeTask schema', () => {
  it('is a workspace/job-scoped durable task with the exact source and status states', () => {
    for (const pathName of ['workspaceId', 'jobId', 'source']) {
      const path = HireIntakeTask.schema.path(pathName)
      expect(path).toBeDefined()
      expect(path.isRequired).toBe(true)
      expect((path.options as { immutable?: boolean }).immutable).toBe(true)
    }

    expect((HireIntakeTask.schema.path('source').options as { enum?: string[] }).enum).toEqual(
      HIRE_INTAKE_TASK_SOURCES,
    )
    expect((HireIntakeTask.schema.path('status').options as { enum?: string[] }).enum).toEqual(
      HIRE_INTAKE_TASK_STATUSES,
    )
    expect(new HireIntakeTask(intakeTaskInput()).validateSync()).toBeUndefined()
  })

  it('validates the original file metadata against a select-hidden payload capped at 10MiB', () => {
    const payloadPath = HireIntakeTask.schema.path('payload')
    expect((payloadPath.options as { select?: boolean }).select).toBe(false)
    expect((payloadPath.options as { immutable?: boolean }).immutable).not.toBe(true)
    expect(new HireIntakeTask(intakeTaskInput()).validateSync()).toBeUndefined()

    const missingPayload = new HireIntakeTask(
      intakeTaskInput({ payload: undefined }),
    ).validateSync()
    expect(missingPayload?.errors.payload).toBeDefined()

    const mismatch = new HireIntakeTask(
      intakeTaskInput({ originalFileSizeBytes: 1 }),
    ).validateSync()
    expect(mismatch?.errors.originalFileSizeBytes).toBeDefined()

    const oversizedPayload = Buffer.alloc(HIRE_INTAKE_TASK_MAX_PAYLOAD_BYTES + 1)
    const oversized = new HireIntakeTask(
      intakeTaskInput({
        payload: oversizedPayload,
        originalFileSizeBytes: oversizedPayload.length,
      }),
    ).validateSync()
    expect(oversized?.errors.payload).toBeDefined()
    expect(oversized?.errors.originalFileSizeBytes).toBeDefined()
  })

  it('requires a hidden hash for public apply work and has no raw-token field', () => {
    const missingHash = new HireIntakeTask(
      intakeTaskInput({ source: 'apply_page' }),
    ).validateSync()
    expect(missingHash?.errors.applyTokenHash).toBeDefined()

    const publicTask = new HireIntakeTask(
      intakeTaskInput({ source: 'apply_page', applyTokenHash: APPLY_TOKEN_HASH }),
    )
    expect(publicTask.validateSync()).toBeUndefined()
    expect((HireIntakeTask.schema.path('applyTokenHash').options as { select?: boolean }).select).toBe(
      false,
    )
    expect(HireIntakeTask.schema.path('applyToken')).toBeUndefined()
    expect(() => new HireIntakeTask(intakeTaskInput({ applyToken: 'raw-capability' }))).toThrow(
      /not in schema/,
    )
  })

  it('allows a workspace-scoped worker update to purge payload and supplied PII', async () => {
    const cleanup = HireIntakeTask.updateOne(
      { _id: new mongoose.Types.ObjectId(), workspaceId: WORKSPACE_ID },
      {
        $set: { status: 'completed', completedAt: new Date('2026-08-12T09:10:00.000Z') },
        $unset: { payload: 1, suppliedName: 1, suppliedEmail: 1, suppliedPhone: 1 },
      },
      { runValidators: true },
    )

    await expect(
      (cleanup as unknown as { validate: () => Promise<void> }).validate(),
    ).resolves.toBeUndefined()
  })

  it('records source identity, member snapshot, worker lease state, status timestamps, and results', () => {
    const task = new HireIntakeTask(
      intakeTaskInput({
        source: 'apply_page',
        applyTokenHash: APPLY_TOKEN_HASH,
        suppliedName: 'Ada Lovelace',
        suppliedEmail: 'ADA@EXAMPLE.COM',
        suppliedPhone: '+91 1234567890',
        actorMemberId: undefined,
        actorName: 'Applicant (public apply page)',
        status: 'needs_identity',
        attempts: 2,
        claimToken: '2b10af40-2d30-4e36-9055-711ad5ad0a1d',
        claimedAt: new Date('2026-08-12T09:00:00.000Z'),
        leaseExpiresAt: new Date('2026-08-12T09:05:00.000Z'),
        nextAttemptAt: new Date('2026-08-12T09:02:00.000Z'),
        lastError: 'No candidate email found in the resume',
        lastErrorAt: new Date('2026-08-12T09:00:00.000Z'),
        needsIdentityAt: new Date('2026-08-12T09:01:00.000Z'),
        statusChangedAt: new Date('2026-08-12T09:01:00.000Z'),
        candidateId: CANDIDATE_ID,
        applicationId: APPLICATION_ID,
      }),
    )

    expect(task.validateSync()).toBeUndefined()
    expect(task.suppliedEmail).toBe('ada@example.com')
    for (const pathName of [
      'actorMemberId',
      'actorName',
      'claimToken',
      'claimedAt',
      'leaseExpiresAt',
      'nextAttemptAt',
      'attempts',
      'lastError',
      'lastErrorAt',
      'queuedAt',
      'statusChangedAt',
      'needsIdentityAt',
      'completedAt',
      'failedAt',
      'cancelledAt',
      'candidateId',
      'applicationId',
    ]) {
      expect(HireIntakeTask.schema.path(pathName)).toBeDefined()
    }
    for (const pathName of ['suppliedName', 'suppliedEmail', 'suppliedPhone']) {
      expect(
        (HireIntakeTask.schema.path(pathName).options as { immutable?: boolean }).immutable,
      ).not.toBe(true)
    }
  })

  it('has workspace-leading indexes for worker claims and per-job status reads', () => {
    const schemaIndexes = indexes(HireIntakeTask as unknown as Model<never>)
    const claimIndex = schemaIndexes.find(
      ([spec]) =>
        spec.workspaceId === 1 &&
        spec.status === 1 &&
        spec.nextAttemptAt === 1 &&
        spec.leaseExpiresAt === 1 &&
        spec.queuedAt === 1 &&
        spec._id === 1,
    )
    const jobStatusIndex = schemaIndexes.find(
      ([spec]) =>
        spec.workspaceId === 1 &&
        spec.jobId === 1 &&
        spec.status === 1 &&
        spec.queuedAt === -1,
    )

    expect(claimIndex).toBeDefined()
    expect(jobStatusIndex).toBeDefined()
    for (const [spec] of schemaIndexes) {
      expect(spec.workspaceId).toBe(1)
    }
  })
})
