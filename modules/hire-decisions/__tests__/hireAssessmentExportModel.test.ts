import mongoose, { type Model } from 'mongoose'
import { describe, expect, it } from 'vitest'
import {
  HIRE_ASSESSMENT_EXPORT_EXPIRY_MS,
  HireAssessmentExport,
  hireAssessmentExportObjectKey,
  parseHireAssessmentExportObjectKey,
  type IHireAssessmentExport,
} from '../models/HireAssessmentExport'
import { HireAssessmentExportCleanup } from '../models/HireAssessmentExportCleanup'
import { aggregateExternalVerdicts, aggregateSubmittedHumanScorecards } from '../services/decisionAggregateService'

const IDS = {
  workspaceId: new mongoose.Types.ObjectId('111111111111111111111111'),
  applicationId: new mongoose.Types.ObjectId('222222222222222222222222'),
  jobId: new mongoose.Types.ObjectId('333333333333333333333333'),
  candidateId: new mongoose.Types.ObjectId('444444444444444444444444'),
  exportId: new mongoose.Types.ObjectId('555555555555555555555555'),
}

function decision() {
  return {
    coordinates: {
      workspaceId: IDS.workspaceId.toString(),
      applicationId: IDS.applicationId.toString(),
      jobId: IDS.jobId.toString(),
      candidateId: IDS.candidateId.toString(),
    },
    candidateBrief: { candidateName: 'Ada Lovelace', jobTitle: 'Platform Engineer' },
    aiAssessments: [],
    humanScorecards: aggregateSubmittedHumanScorecards([]),
    externalVerdicts: aggregateExternalVerdicts([]),
  }
}

function row(overrides: Record<string, unknown> = {}) {
  const requestedAt = new Date('2026-08-14T10:00:00.000Z')
  const { exportId: _exportId, ...coordinates } = IDS
  return {
    ...coordinates,
    _id: IDS.exportId,
    creationOperationId: '11111111-1111-4111-8111-111111111111',
    objectKey: hireAssessmentExportObjectKey({
      workspaceId: IDS.workspaceId.toString(),
      applicationId: IDS.applicationId.toString(),
      jobId: IDS.jobId.toString(),
      candidateId: IDS.candidateId.toString(),
      exportId: IDS.exportId.toString(),
    }),
    decisionSnapshot: decision(),
    requestedAt,
    expiresAt: new Date(requestedAt.getTime() + HIRE_ASSESSMENT_EXPORT_EXPIRY_MS),
    status: 'pending',
    attempts: 0,
    nextRetryAt: requestedAt,
    ...overrides,
  }
}

function indexes(model: Model<never>): Array<[Record<string, number>, Record<string, unknown>]> {
  return model.schema.indexes() as Array<[Record<string, number>, Record<string, unknown>]>
}

describe('Hire assessment export durable model', () => {
  it('makes full Hire coordinates and the member operation id immutable', () => {
    for (const field of ['workspaceId', 'applicationId', 'jobId', 'candidateId', 'creationOperationId']) {
      const path = HireAssessmentExport.schema.path(field)
      expect(path).toBeDefined()
      expect(path.isRequired).toBe(true)
      expect((path.options as { immutable?: boolean }).immutable).toBe(true)
    }
    expect(HireAssessmentExport.schema.path('candidateEmail')).toBeUndefined()
    expect(HireAssessmentExport.schema.path('resumeText')).toBeUndefined()
    expect(HireAssessmentExport.schema.path('mediaAssetId')).toBeUndefined()
    expect(HireAssessmentExport.schema.path('closeNote')).toBeUndefined()
  })

  it('keeps the key and safe snapshot select-hidden, key-bound, and expiry-bounded', () => {
    expect((HireAssessmentExport.schema.path('objectKey').options as { select?: boolean }).select).toBe(false)
    expect((HireAssessmentExport.schema.path('decisionSnapshot').options as { select?: boolean }).select).toBe(false)
    expect(new HireAssessmentExport(row()).validateSync()).toBeUndefined()

    const invalidKey = new HireAssessmentExport(row({ objectKey: 'hire-assessment-exports/v1/forged.pdf' })).validateSync()
    expect(invalidKey?.errors.objectKey).toBeDefined()

    const oversizedExpiry = new HireAssessmentExport(row({
      expiresAt: new Date(new Date('2026-08-14T10:00:00.000Z').getTime() + HIRE_ASSESSMENT_EXPORT_EXPIRY_MS + 1),
    })).validateSync()
    expect(oversizedExpiry?.errors.expiresAt).toBeDefined()
  })

  it('uses a deterministic full-coordinate key grammar with no path escape', () => {
    const key = row().objectKey as string
    expect(parseHireAssessmentExportObjectKey(key)).toEqual({
      workspaceId: IDS.workspaceId.toString(),
      jobId: IDS.jobId.toString(),
      applicationId: IDS.applicationId.toString(),
      candidateId: IDS.candidateId.toString(),
      exportId: IDS.exportId.toString(),
    })
    expect(parseHireAssessmentExportObjectKey(`${key}%2fescape`)).toBeNull()
    expect(parseHireAssessmentExportObjectKey(`${key}\\escape`)).toBeNull()
  })

  it('declares workspace-leading operational indexes and intentionally no TTL index', () => {
    const declared = indexes(HireAssessmentExport as unknown as Model<never>)
    expect(declared).toHaveLength(5)
    for (const [spec, options] of declared) {
      expect(spec.workspaceId).toBe(1)
      expect(options.expireAfterSeconds).toBeUndefined()
    }
    expect(declared.find(([spec]) => spec.creationOperationId === 1)?.[1].unique).toBe(true)
    expect(declared.some(([spec]) => spec.jobId === 1 && spec.status === 1)).toBe(true)
  })

  it('keeps a deletion-only cleanup tombstone with immutable IDs and global recovery indexes', () => {
    for (const field of ['workspaceId', 'applicationId', 'jobId', 'candidateId', 'exportId']) {
      const path = HireAssessmentExportCleanup.schema.path(field)
      expect(path.isRequired).toBe(true)
      expect((path.options as { immutable?: boolean }).immutable).toBe(true)
    }
    expect(HireAssessmentExportCleanup.schema.path('objectKey')).toBeUndefined()
    expect(HireAssessmentExportCleanup.schema.path('decisionSnapshot')).toBeUndefined()
    expect(HireAssessmentExportCleanup.schema.path('candidateEmail')).toBeUndefined()

    const declared = indexes(HireAssessmentExportCleanup as unknown as Model<never>)
    expect(declared).toHaveLength(2)
    expect(declared.find(([spec]) => spec.workspaceId === 1 && spec.exportId === 1)?.[1].unique).toBe(true)
    expect(declared.some(([spec]) => spec.firstSweepAt === 1 && spec.nextRetryAt === 1)).toBe(true)
  })

  it('keeps the status/lease state explicit and bounded', () => {
    const generating = new HireAssessmentExport(row({
      status: 'generating',
      claimToken: 'claim',
      leaseExpiresAt: new Date('2026-08-14T10:05:00.000Z'),
    }))
    expect(generating.validateSync()).toBeUndefined()
    const badGenerating = new HireAssessmentExport(row({ status: 'generating' })).validateSync()
    expect(badGenerating?.errors.status).toBeDefined()
    const badAttempts = new HireAssessmentExport(row({ attempts: 6 })).validateSync()
    expect(badAttempts?.errors.attempts).toBeDefined()
  })
})
