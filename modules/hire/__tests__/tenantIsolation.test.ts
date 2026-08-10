/**
 * Cross-tenant isolation — schema-level guarantees (goal item 3).
 *
 * Uses the REAL Mongoose schemas (no mocks): every hire collection except the
 * tenancy root itself must carry a required, immutable workspaceId, and the
 * uniqueness constraints that make tenancy + claiming safe must exist.
 * Query-level scoping (every service filter threads workspaceId) is asserted
 * in the per-service suites; this file guards the schema substrate they rely
 * on so a refactor can't silently drop the key.
 */

import { describe, it, expect } from 'vitest'
import {
  HireWorkspace,
  HireWorkspaceMember,
  HireMemberSetup,
  HireMemberSession,
  HireJob,
  HireJobRequirementVersion,
  HireEmailOutbox,
  HireAiInviteDelivery,
  HireCandidate,
  HireApplication,
  HireRound,
  HireEngineHandoff,
  HireEngineIngestionEvent,
  HireGuestSession,
  HireConsentReceipt,
  HireInterviewAttempt,
  HireInterviewResult,
  HireMediaAsset,
  HirePrivacyRequest,
} from '../models'
import type { Model } from 'mongoose'

const TENANT_SCOPED: Array<[string, Model<never>]> = [
  ['HireWorkspaceMember', HireWorkspaceMember as unknown as Model<never>],
  ['HireMemberSetup', HireMemberSetup as unknown as Model<never>],
  ['HireMemberSession', HireMemberSession as unknown as Model<never>],
  ['HireJob', HireJob as unknown as Model<never>],
  ['HireJobRequirementVersion', HireJobRequirementVersion as unknown as Model<never>],
  ['HireEmailOutbox', HireEmailOutbox as unknown as Model<never>],
  ['HireAiInviteDelivery', HireAiInviteDelivery as unknown as Model<never>],
  ['HireCandidate', HireCandidate as unknown as Model<never>],
  ['HireApplication', HireApplication as unknown as Model<never>],
  ['HireRound', HireRound as unknown as Model<never>],
  ['HireEngineHandoff', HireEngineHandoff as unknown as Model<never>],
  ['HireEngineIngestionEvent', HireEngineIngestionEvent as unknown as Model<never>],
  ['HireGuestSession', HireGuestSession as unknown as Model<never>],
  ['HireConsentReceipt', HireConsentReceipt as unknown as Model<never>],
  ['HireInterviewAttempt', HireInterviewAttempt as unknown as Model<never>],
  ['HireInterviewResult', HireInterviewResult as unknown as Model<never>],
  ['HireMediaAsset', HireMediaAsset as unknown as Model<never>],
  ['HirePrivacyRequest', HirePrivacyRequest as unknown as Model<never>],
]

function indexes(model: Model<never>): Array<[Record<string, number>, Record<string, unknown>]> {
  return model.schema.indexes() as Array<[Record<string, number>, Record<string, unknown>]>
}

describe('workspaceId scoping', () => {
  it.each(TENANT_SCOPED)('%s requires an immutable workspaceId', (_name, model) => {
    const path = model.schema.path('workspaceId')
    expect(path).toBeDefined()
    expect(path.isRequired).toBe(true)
    expect((path.options as { immutable?: boolean }).immutable).toBe(true)
  })

  it('HireWorkspace is the tenancy root (no workspaceId on itself)', () => {
    expect(HireWorkspace.schema.path('workspaceId')).toBeUndefined()
  })
})

describe('uniqueness constraints', () => {
  it('one pending or active membership per normalized HR email per workspace', () => {
    const idx = indexes(HireWorkspaceMember as unknown as Model<never>).find(
      ([spec]) =>
        spec.workspaceId === 1 &&
        spec.normalizedEmail === 1 &&
        Object.keys(spec).length === 2
    )
    expect(idx?.[1].unique).toBe(true)
    expect(idx?.[1].partialFilterExpression).toEqual({
      authState: { $in: ['pending', 'active'] },
    })
  })

  it('one candidate per email per workspace', () => {
    const idx = indexes(HireCandidate as unknown as Model<never>).find(
      ([spec]) => spec.workspaceId === 1 && spec.email === 1
    )
    expect(idx?.[1].unique).toBe(true)
  })

  it('one application per candidate per job', () => {
    const idx = indexes(HireApplication as unknown as Model<never>).find(
      ([spec]) => spec.workspaceId === 1 && spec.jobId === 1 && spec.candidateId === 1
    )
    expect(idx?.[1].unique).toBe(true)
  })

  it('one round per opaque runtime session — the ingestion double-claim guard', () => {
    const idx = indexes(HireRound as unknown as Model<never>).find(
      ([spec]) => spec.runtimeSessionId === 1
    )
    expect(idx?.[1].unique).toBe(true)
    expect(idx?.[1].sparse).toBe(true)
    expect(HireRound.schema.path('sessionId')).toBeUndefined()
    expect(HireRound.schema.path('guestUserId')).toBeUndefined()
    expect(HireRound.schema.path('runtimeSessionId').options.ref).toBeUndefined()
  })

  it('one LIVE round per application — enforced by a partial unique index, not just app code', () => {
    const idx = indexes(HireRound as unknown as Model<never>).find(
      ([spec]) => spec.workspaceId === 1 && spec.applicationId === 1 && spec.live === 1
    )
    expect(idx?.[1].unique).toBe(true)
    expect(idx?.[1].partialFilterExpression).toEqual({ live: true })
  })

  it('one LINKED workspace per user — unique sparse userId index on memberships', () => {
    const idx = indexes(HireWorkspaceMember as unknown as Model<never>).find(
      ([spec]) => spec.userId === 1
    )
    expect(idx?.[1].unique).toBe(true)
    expect(idx?.[1].sparse).toBe(true)
  })
})

describe('token storage', () => {
  it('HireRound stores a token hash + expiry, never a raw token field', () => {
    expect(HireRound.schema.path('inviteTokenHash')).toBeDefined()
    expect(HireRound.schema.path('inviteTokenExpiry')).toBeDefined()
    expect(HireRound.schema.path('inviteToken')).toBeUndefined()
  })

  it('AI invite recovery stores authenticated ciphertext with bounded TTL, never plaintext', () => {
    expect(HireAiInviteDelivery.schema.path('ciphertext')).toBeDefined()
    expect(HireAiInviteDelivery.schema.path('iv')).toBeDefined()
    expect(HireAiInviteDelivery.schema.path('authTag')).toBeDefined()
    expect(HireAiInviteDelivery.schema.path('keyId')).toBeDefined()
    expect(HireAiInviteDelivery.schema.path('rawToken')).toBeUndefined()
    expect(HireAiInviteDelivery.schema.path('inviteUrl')).toBeUndefined()
    const ttl = indexes(HireAiInviteDelivery as unknown as Model<never>).find(
      ([spec]) => spec.expiresAt === 1,
    )
    expect(ttl?.[1].expireAfterSeconds).toBe(0)
  })
})
