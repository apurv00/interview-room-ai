import { describe, expect, it } from 'vitest'
import type { Model } from 'mongoose'
import {
  HIRE_MEMBER_ACTIVE_EMAIL_INDEX_KEY,
  HIRE_MEMBER_ACTIVE_EMAIL_INDEX_NAME,
  HIRE_MEMBER_ACTIVE_EMAIL_INDEX_PARTIAL,
  HireWorkspaceMember,
  normalizeHireMemberEmail,
} from '../models/HireWorkspaceMember'
import { HireMemberSetup } from '../models/HireMemberSetup'
import { HireMemberSession } from '../models/HireMemberSession'

function indexes(model: Model<never>) {
  return model.schema.indexes() as Array<
    [Record<string, number>, Record<string, unknown>]
  >
}

describe('Hire member identity schema', () => {
  it('normalizes login emails before lookup or persistence', () => {
    expect(normalizeHireMemberEmail('  HR.Owner@Example.COM ')).toBe(
      'hr.owner@example.com',
    )
  })

  it('has one workspace-scoped unique normalized-email key for pending/active rows', () => {
    const schemaIndexes = indexes(HireWorkspaceMember as unknown as Model<never>)
    const identity = schemaIndexes.find(
      ([key, options]) =>
        key.workspaceId === HIRE_MEMBER_ACTIVE_EMAIL_INDEX_KEY.workspaceId &&
        key.normalizedEmail === HIRE_MEMBER_ACTIVE_EMAIL_INDEX_KEY.normalizedEmail &&
        options.name === HIRE_MEMBER_ACTIVE_EMAIL_INDEX_NAME,
    )
    expect(identity?.[1]).toMatchObject({
      unique: true,
      partialFilterExpression: HIRE_MEMBER_ACTIVE_EMAIL_INDEX_PARTIAL,
    })
  })

  it('does not retain the legacy non-partial workspace email index', () => {
    const schemaIndexes = indexes(HireWorkspaceMember as unknown as Model<never>)
    expect(
      schemaIndexes.some(
        ([key, options]) =>
          key.workspaceId === 1 && key.email === 1 && options.unique === true,
      ),
    ).toBe(false)
  })

  it('canonicalizes both stored fields during document validation', async () => {
    const member = new HireWorkspaceMember({
      workspaceId: '111111111111111111111111',
      email: '  Member@Example.COM ',
      normalizedEmail: 'ignored@example.net',
      name: 'Member',
      role: 'member',
      authState: 'pending',
      addedByName: 'Admin',
    })
    await member.validate()
    expect(member.email).toBe('member@example.com')
    expect(member.normalizedEmail).toBe('member@example.com')
  })

  it.each([
    ['setup', HireMemberSetup],
    ['session', HireMemberSession],
  ])('stores %s token uniqueness inside workspaceId', (_name, model) => {
    const tokenIndex = indexes(model as unknown as Model<never>).find(
      ([key]) => key.workspaceId === 1 && key.tokenHash === 1,
    )
    expect(tokenIndex?.[1].unique).toBe(true)
    expect(
      indexes(model as unknown as Model<never>).some(
        ([key, options]) =>
          key.tokenHash === 1 && Object.keys(key).length === 1 && options.unique === true,
      ),
    ).toBe(false)
  })
})
