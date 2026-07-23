import mongoose from 'mongoose'
import { describe, expect, it } from 'vitest'
import { JobQualityDecision } from '@shared/db/models/JobQualityDecision'

const NOW = new Date('2026-07-22T04:00:00.000Z')

function automaticRoot() {
  return {
    recordType: 'automatic' as const,
    decisionKey: `quality:v1:${'a'.repeat(64)}`,
    domain: 'hard-drop' as const,
    automaticAction: 'drop' as const,
    subjectKeyHash: 'b'.repeat(64),
    inputHash: 'c'.repeat(64),
    policyRevision: 'quality-gate:v3',
    sourceRevisions: [{ sourceId: 'jsearch', controlRevision: 2, operationalRevision: 5 }],
    evidence: {
      kind: 'hard-drop' as const,
      reasonCodes: ['thin-jd'],
      bodyLength: 40,
      applyHosts: ['jobs.example.com'],
    },
    reviewOverlay: {
      title: 'Frontend Engineer',
      company: 'Example Ltd',
      city: 'Bengaluru',
      isRemote: false,
      descriptionExcerpt: 'A bounded normalized job description for review.',
      viaSite: 'Example Jobs',
      domainHint: 'frontend',
    },
    serviceActor: 'jobs-ingest' as const,
    reviewStatus: 'unreviewed' as const,
    reviewRevision: 0,
    seenCount: 1,
    lastSeenAt: NOW,
    occurredAt: NOW,
  }
}

describe('JobQualityDecision model', () => {
  it('validates an evidence-complete automatic root and immutable review child', async () => {
    const root = new JobQualityDecision(automaticRoot())
    await expect(root.validate()).resolves.toBeUndefined()

    const child = new JobQualityDecision({
      recordType: 'review',
      operationId: '018f6f08-8c2d-7b2e-9ca1-4ad0e35f8321',
      commandHash: 'f'.repeat(64),
      rootDecisionId: root._id,
      rootDecisionKey: root.decisionKey,
      domain: root.domain,
      reviewAction: 'restore',
      actorUserId: new mongoose.Types.ObjectId('507f191e810c19729de860ea'),
      reason: 'Confirmed false positive after current-authority revalidation.',
      fromReviewStatus: 'unreviewed',
      toReviewStatus: 'restored',
      previousReviewRevision: 0,
      resultingReviewRevision: 1,
      occurredAt: NOW,
    })
    await expect(child.validate()).resolves.toBeUndefined()
    expect(JobQualityDecision.schema.path('operationId').options.immutable).toBe(true)
    expect(JobQualityDecision.schema.path('reason').options.immutable).toBe(true)
    expect(JobQualityDecision.schema.path('resultingReviewRevision').options.immutable).toBe(true)
  })

  it('rejects a hard-drop root without a bounded review overlay', async () => {
    const value = automaticRoot()
    delete (value as Partial<typeof value>).reviewOverlay

    await expect(new JobQualityDecision(value).validate())
      .rejects.toThrow(/hard-drop decisions require a bounded review overlay/)
  })

  it('retains empty review strings without adding raw job fields or URLs', async () => {
    const value = automaticRoot()
    value.reviewOverlay = {
      ...value.reviewOverlay,
      title: '',
      company: '',
      city: '',
      descriptionExcerpt: '',
      viaSite: '',
      domainHint: '',
    }
    const doc = new JobQualityDecision(value)

    await expect(doc.validate()).resolves.toBeUndefined()
    expect(doc.toObject().reviewOverlay).toMatchObject({
      title: '', company: '', city: '', descriptionExcerpt: '', viaSite: '',
      domainHint: '',
    })
    expect(doc.toObject().reviewOverlay).not.toHaveProperty('applyOptions')
    expect(doc.toObject().reviewOverlay).not.toHaveProperty('externalId')
    expect(JSON.stringify(doc.toObject().reviewOverlay)).not.toContain('https://')
  })

  it('fails closed instead of retaining arbitrary nested evidence', async () => {
    const value = automaticRoot()
    const doc = new JobQualityDecision({
      ...value,
      evidence: { ...value.evidence, rawProviderBody: { authorization: 'secret' } },
    })
    expect(doc.toObject().evidence).toBeUndefined()
    await expect(doc.validate()).rejects.toThrow(/require identity, evidence/)
  })

  it('declares partial unique roots/reviews plus deterministic queue/history indexes', () => {
    const indexes = JobQualityDecision.schema.indexes()
    expect(indexes).toEqual(expect.arrayContaining([
      [
        { decisionKey: 1 },
        expect.objectContaining({
          name: 'job_quality_decision_key_uq',
          unique: true,
          partialFilterExpression: { recordType: 'automatic' },
        }),
      ],
      [
        { operationId: 1 },
        expect.objectContaining({
          name: 'job_quality_review_operation_uq',
          unique: true,
          partialFilterExpression: { recordType: 'review' },
        }),
      ],
      [
        { recordType: 1, reviewStatus: 1, occurredAt: -1, _id: -1 },
        expect.objectContaining({ name: 'job_quality_review_queue' }),
      ],
      [
        { rootDecisionId: 1, occurredAt: 1, _id: 1 },
        expect.objectContaining({ name: 'job_quality_review_history' }),
      ],
    ]))
  })
})
