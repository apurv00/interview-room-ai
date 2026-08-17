import { describe, expect, it } from 'vitest'
import mongoose, { type Model } from 'mongoose'
import { HireApplication } from '../models/HireApplication'
import { HireEmailOutbox } from '../models/HireEmailOutbox'
import { HireJob } from '../models/HireJob'
import { HireJobRequirementVersion } from '../models/HireJobRequirementVersion'

function indexes(model: Model<never>): Array<[Record<string, number>, Record<string, unknown>]> {
  return model.schema.indexes() as Array<[Record<string, number>, Record<string, unknown>]>
}

describe('Phase-1 scoring contract schema', () => {
  it('requires one workspace-scoped department for every job', () => {
    const departmentPath = HireJob.schema.path('departmentId')
    expect(departmentPath).toBeDefined()
    expect(departmentPath.isRequired).toBe(true)
    expect((departmentPath.options as { ref?: string }).ref).toBe('HireDepartment')

    const schemaIndexes = indexes(HireJob as unknown as Model<never>)
    expect(schemaIndexes).toContainEqual([
      { workspaceId: 1, departmentId: 1, status: 1, createdAt: -1 },
      {},
    ])
  })

  it('keeps the apply-link secret hidden from ordinary job projections', () => {
    const secretPath = HireJob.schema.path('applyTokenSecret')
    expect(secretPath).toBeDefined()
    expect((secretPath.options as { select?: boolean }).select).toBe(false)
    expect((secretPath.options as { minlength?: number }).minlength).toBe(64)
    expect((secretPath.options as { maxlength?: number }).maxlength).toBe(64)
    expect(HireJob.schema.path('applyLinkRecovery')).toBeUndefined()
  })

  it('is workspace-owned and immutable except for active/superseded state', () => {
    for (const pathName of [
      'workspaceId',
      'jobId',
      'version',
      'input',
      'proseJd',
      'requirements',
      'contentHash',
    ]) {
      const path = HireJobRequirementVersion.schema.path(pathName)
      expect(path).toBeDefined()
      expect((path.options as { immutable?: boolean }).immutable).toBe(true)
    }
    expect(
      (HireJobRequirementVersion.schema.path('state').options as { immutable?: boolean }).immutable,
    ).not.toBe(true)
  })

  it('allows only one numbered revision and one active revision per workspace job', () => {
    const schemaIndexes = indexes(HireJobRequirementVersion as unknown as Model<never>)
    const numbered = schemaIndexes.find(
      ([spec]) => spec.workspaceId === 1 && spec.jobId === 1 && spec.version === 1,
    )
    const active = schemaIndexes.find(
      ([spec]) => spec.workspaceId === 1 && spec.jobId === 1 && spec.state === 1,
    )
    expect(numbered?.[1].unique).toBe(true)
    expect(active?.[1]).toMatchObject({
      unique: true,
      partialFilterExpression: { state: 'active' },
    })
  })

  it('keeps legacy free-text levels and versions without range or responsibilities valid', () => {
    const legacy = new HireJobRequirementVersion({
      workspaceId: new mongoose.Types.ObjectId(),
      jobId: new mongoose.Types.ObjectId(),
      version: 1,
      state: 'active',
      input: {
        role: 'Backend Engineer',
        level: 'Senior',
        mustHaves: ['Production TypeScript'],
        niceToHaves: [],
        location: 'Remote',
        workMode: 'hybrid',
        companyBlurb: 'Acme builds reliable hiring tools.',
      },
      proseJd: 'A reviewed job description that remains valid for historical scoring.',
      requirements: [
        { id: 'must-typescript', text: 'Production TypeScript', importance: 'must_have' },
      ],
      contentHash: 'a'.repeat(64),
      createdByMemberId: new mongoose.Types.ObjectId(),
      createdByName: 'HR One',
    })

    expect(legacy.validateSync()).toBeUndefined()
    expect(legacy.input.responsibilities).toBeUndefined()
  })
})

describe('Phase-1 decision and close durability', () => {
  it('persists withdrawn, offer outcome, actor snapshots, and operation ids', () => {
    expect(
      (HireApplication.schema.path('stage').options as { enum?: string[] }).enum,
    ).toContain('withdrawn')
    expect(HireApplication.schema.path('offerDecision.outcome')).toBeDefined()
    expect(HireApplication.schema.path('events.actorMemberId')).toBeDefined()
    expect(HireApplication.schema.path('events.actorName')).toBeDefined()
    expect(HireApplication.schema.path('events.operationId')).toBeDefined()
    expect(HireJob.schema.path('events.actorMemberId')).toBeDefined()
    expect(HireJob.schema.path('events.actorName')).toBeDefined()
    expect(HireJob.schema.path('events.operationId')).toBeDefined()
  })

  it('deduplicates one rejection outbox row per close operation and application', () => {
    const outboxIndexes = indexes(HireEmailOutbox as unknown as Model<never>)
    const idempotency = outboxIndexes.find(
      ([spec]) =>
        spec.workspaceId === 1 &&
        spec.operationId === 1 &&
        spec.applicationId === 1 &&
        spec.kind === 1,
    )
    expect(idempotency?.[1].unique).toBe(true)
    expect(HireEmailOutbox.schema.path('workspaceId').isRequired).toBe(true)
    expect(
      (HireEmailOutbox.schema.path('workspaceId').options as { immutable?: boolean }).immutable,
    ).toBe(true)
  })

  it('keeps Phase-4 rendered recipient copy immutable while accepting legacy rows without it', () => {
    const snapshotPath = HireEmailOutbox.schema.path('payload.emailSnapshot')
    expect(snapshotPath).toBeDefined()
    expect((snapshotPath.options as { immutable?: boolean }).immutable).toBe(true)
    expect(HireEmailOutbox.schema.path('payload.emailSnapshot.subject')).toBeDefined()
    expect(HireEmailOutbox.schema.path('payload.emailSnapshot.body')).toBeDefined()

    const legacy = new HireEmailOutbox({
      workspaceId: new mongoose.Types.ObjectId(),
      jobId: new mongoose.Types.ObjectId(),
      applicationId: new mongoose.Types.ObjectId(),
      candidateId: new mongoose.Types.ObjectId(),
      kind: 'job_close_rejection',
      operationId: '11111111-1111-4111-8111-111111111111',
      recipientEmail: 'candidate@example.com',
      recipientName: 'Candidate One',
      payload: {
        jobTitle: 'Backend Engineer',
        workspaceName: 'Acme',
        decisionNote: 'Internal only',
        actorName: 'HR One',
      },
      sendAfter: new Date('2026-08-14T00:00:00.000Z'),
    })
    expect(legacy.validateSync()).toBeUndefined()

    const malformedSnapshot = new HireEmailOutbox({
      ...legacy.toObject(),
      payload: {
        ...legacy.payload,
        emailSnapshot: { subject: 'Update\r\nBcc: attacker@example.com', body: 'Hi there' },
      },
    }).validateSync()
    expect(malformedSnapshot?.errors['payload.emailSnapshot.subject']).toBeDefined()
  })
})
