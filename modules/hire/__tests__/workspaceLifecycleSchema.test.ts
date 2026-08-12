import { describe, expect, it } from 'vitest'
import { HireWorkspace, HireWorkspaceMember } from '../models'
import {
  RestoreWorkspaceSchema,
  SoftDeleteWorkspaceSchema,
  TransferWorkspaceAdminSchema,
  UpdateWorkspaceSettingsSchema,
} from '../validators/hire'

describe('workspace authority schema', () => {
  it('has a database-level at-most-one-admin invariant per workspace', () => {
    const adminIndex = HireWorkspaceMember.schema.indexes().find(
      ([fields]) => fields.workspaceId === 1 && fields.role === 1,
    )

    expect(adminIndex?.[1]).toMatchObject({
      unique: true,
      partialFilterExpression: { role: 'admin' },
    })
  })

  it('never TTL-deletes only the workspace root', () => {
    const retentionIndex = HireWorkspace.schema.indexes().find(
      ([fields]) => fields.lifecycleState === 1 && fields.purgeAfter === 1,
    )

    expect(retentionIndex).toBeDefined()
    expect(retentionIndex?.[1]).not.toHaveProperty('expireAfterSeconds')
  })
})

describe('workspace lifecycle validators', () => {
  const operationId = '123e4567-e89b-42d3-a456-426614174000'

  it('requires explicit delete confirmation and rejects unknown fields', () => {
    expect(
      SoftDeleteWorkspaceSchema.safeParse({
        confirmationName: 'Acme',
        acknowledgePermanentPurge: true,
        operationId,
      }).success,
    ).toBe(true)
    expect(
      SoftDeleteWorkspaceSchema.safeParse({
        confirmationName: 'Acme',
        acknowledgePermanentPurge: false,
        operationId,
      }).success,
    ).toBe(false)
    expect(
      SoftDeleteWorkspaceSchema.safeParse({
        confirmationName: 'Acme',
        acknowledgePermanentPurge: true,
        operationId,
        workspaceId: 'foreign',
      }).success,
    ).toBe(false)
  })

  it('requires UUID operation ids for retry-safe transfer and restore', () => {
    expect(TransferWorkspaceAdminSchema.parse({ operationId })).toEqual({ operationId })
    expect(RestoreWorkspaceSchema.parse({ operationId })).toEqual({ operationId })
    expect(TransferWorkspaceAdminSchema.safeParse({ operationId: 'retry-me' }).success)
      .toBe(false)
  })

  it('accepts a bounded optional Smart-JD company blurb', () => {
    expect(UpdateWorkspaceSettingsSchema.parse({ companyBlurb: 'About Acme' }))
      .toEqual({ companyBlurb: 'About Acme' })
    expect(UpdateWorkspaceSettingsSchema.safeParse({ companyBlurb: 'x'.repeat(2001) }).success)
      .toBe(false)
    expect(UpdateWorkspaceSettingsSchema.safeParse({}).success).toBe(false)
  })
})
