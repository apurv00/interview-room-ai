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
  HireJob,
  HireCandidate,
  HireApplication,
  HireRound,
} from '../models'
import type { Model } from 'mongoose'

const TENANT_SCOPED: Array<[string, Model<never>]> = [
  ['HireWorkspaceMember', HireWorkspaceMember as unknown as Model<never>],
  ['HireJob', HireJob as unknown as Model<never>],
  ['HireCandidate', HireCandidate as unknown as Model<never>],
  ['HireApplication', HireApplication as unknown as Model<never>],
  ['HireRound', HireRound as unknown as Model<never>],
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
  it('one membership per email per workspace', () => {
    const idx = indexes(HireWorkspaceMember as unknown as Model<never>).find(
      ([spec]) => spec.workspaceId === 1 && spec.email === 1
    )
    expect(idx?.[1].unique).toBe(true)
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

  it('one round per engine session — the reconciliation double-claim guard', () => {
    const idx = indexes(HireRound as unknown as Model<never>).find(
      ([spec]) => spec.sessionId === 1
    )
    expect(idx?.[1].unique).toBe(true)
    expect(idx?.[1].sparse).toBe(true)
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
})
