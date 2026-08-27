import { describe, expect, it } from 'vitest'
import {
  HireCandidateBulkOperation,
  HireCandidateBulkOperationItem,
  HIRE_CANDIDATE_BULK_ITEM_APPLICATION_INDEX,
  HIRE_CANDIDATE_BULK_ITEM_CLAIM_INDEX,
  HIRE_CANDIDATE_BULK_ITEM_ISSUE_INDEX,
  HIRE_CANDIDATE_BULK_ITEM_LEASE_INDEX,
  HIRE_CANDIDATE_BULK_ITEM_TTL_INDEX,
  HIRE_CANDIDATE_BULK_OPERATION_IDEMPOTENCY_INDEX,
  HIRE_CANDIDATE_BULK_OPERATION_JOB_HISTORY_INDEX,
  HIRE_CANDIDATE_BULK_OPERATION_RECOVERY_INDEX,
  HIRE_CANDIDATE_BULK_OPERATION_TTL_INDEX,
} from '../models'

describe('candidate bulk persistence schemas', () => {
  it('never delegates collection or index creation to application startup', () => {
    for (const model of [HireCandidateBulkOperation, HireCandidateBulkOperationItem]) {
      expect(model.schema.options.autoCreate).toBe(false)
      expect(model.schema.options.autoIndex).toBe(false)
    }
  })

  it('declares the exact operation indexes owned by the explicit preparer', () => {
    expect(HireCandidateBulkOperation.schema.indexes()).toEqual(
      expect.arrayContaining([
        [
          { workspaceId: 1, requestedByMemberId: 1, clientOperationId: 1 },
          expect.objectContaining({
            name: HIRE_CANDIDATE_BULK_OPERATION_IDEMPOTENCY_INDEX,
            unique: true,
          }),
        ],
        [
          { purgeAt: 1 },
          expect.objectContaining({
            name: HIRE_CANDIDATE_BULK_OPERATION_TTL_INDEX,
            expireAfterSeconds: 0,
          }),
        ],
        [
          { workspaceId: 1, status: 1, nextRecoveryAt: 1, updatedAt: 1, _id: 1 },
          expect.objectContaining({ name: HIRE_CANDIDATE_BULK_OPERATION_RECOVERY_INDEX }),
        ],
        [
          { workspaceId: 1, jobId: 1, createdAt: -1, _id: -1 },
          expect.objectContaining({ name: HIRE_CANDIDATE_BULK_OPERATION_JOB_HISTORY_INDEX }),
        ],
      ]),
    )
  })

  it('declares separate due-row and expired-lease access paths', () => {
    expect(HireCandidateBulkOperationItem.schema.indexes()).toEqual(
      expect.arrayContaining([
        [
          { workspaceId: 1, bulkOperationId: 1, applicationId: 1 },
          expect.objectContaining({
            name: HIRE_CANDIDATE_BULK_ITEM_APPLICATION_INDEX,
            unique: true,
            partialFilterExpression: { privacyRedactedAt: { $exists: false } },
          }),
        ],
        [
          { workspaceId: 1, bulkOperationId: 1, status: 1, nextAttemptAt: 1, _id: 1 },
          expect.objectContaining({ name: HIRE_CANDIDATE_BULK_ITEM_CLAIM_INDEX }),
        ],
        [
          { workspaceId: 1, bulkOperationId: 1, status: 1, leaseExpiresAt: 1, _id: 1 },
          expect.objectContaining({ name: HIRE_CANDIDATE_BULK_ITEM_LEASE_INDEX }),
        ],
        [
          { workspaceId: 1, bulkOperationId: 1, status: 1, _id: 1 },
          expect.objectContaining({ name: HIRE_CANDIDATE_BULK_ITEM_ISSUE_INDEX }),
        ],
        [
          { purgeAt: 1 },
          expect.objectContaining({
            name: HIRE_CANDIDATE_BULK_ITEM_TTL_INDEX,
            expireAfterSeconds: 0,
          }),
        ],
      ]),
    )
  })

  it('persists only opaque candidate/application coordinates and controlled outcomes', () => {
    for (const forbidden of [
      'candidateName',
      'candidateEmail',
      'resumeText',
      'providerError',
      'rawError',
      'evidence',
      'note',
    ]) {
      expect(HireCandidateBulkOperation.schema.path(forbidden)).toBeUndefined()
      expect(HireCandidateBulkOperationItem.schema.path(forbidden)).toBeUndefined()
    }
  })
})
