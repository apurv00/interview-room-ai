import { describe, expect, it } from 'vitest'
import mongoose from 'mongoose'
import {
  HireWorkspaceSignInSlug,
  HIRE_WORKSPACE_SIGN_IN_RESERVATION_INDEX_KEY,
  HIRE_WORKSPACE_SIGN_IN_RESERVATION_INDEX_NAME,
  HIRE_WORKSPACE_SIGN_IN_RESERVATION_INDEX_PARTIAL,
  HIRE_WORKSPACE_SIGN_IN_SLUG_INDEX_KEY,
  HIRE_WORKSPACE_SIGN_IN_SLUG_INDEX_NAME,
  HIRE_WORKSPACE_SIGN_IN_SLUG_INDEX_PARTIAL,
  hireWorkspaceSignInSlugBase,
  hireWorkspaceSignInSlugCandidates,
  hireWorkspaceSignInSlugHash,
  parseHireWorkspaceSignInSlug,
} from '../models/HireWorkspaceSignInSlug'

describe('Hire workspace sign-in slugs', () => {
  it('derives readable canonical names and protects reserved coordinates', () => {
    expect(hireWorkspaceSignInSlugBase('Acme & Co.')).toBe('acme-co')
    expect(hireWorkspaceSignInSlugBase('Crème Brûlée')).toBe('creme-brulee')
    expect(hireWorkspaceSignInSlugBase('管理会社')).toBe('company')
    expect(hireWorkspaceSignInSlugBase('Admin')).toBe('company-admin')
    expect(hireWorkspaceSignInSlugBase('abcdefabcdefabcdefabcdef')).toBe(
      'company-abcdefabcdefabcdefabcdef',
    )
  })

  it('parses exact slugs but rejects routes, punycode, and legacy ObjectIds', () => {
    expect(parseHireWorkspaceSignInSlug(' Acme-India ')).toBe('acme-india')
    expect(parseHireWorkspaceSignInSlug('workspace')).toBeNull()
    expect(parseHireWorkspaceSignInSlug('xn--acme')).toBeNull()
    expect(parseHireWorkspaceSignInSlug('a'.repeat(24))).toBeNull()
    expect(parseHireWorkspaceSignInSlug('acme india')).toBeNull()
  })

  it('generates deterministic collision candidates and one-way reservations', () => {
    const workspaceId = new mongoose.Types.ObjectId('111111111111111122223333')
    expect(hireWorkspaceSignInSlugCandidates('Acme', workspaceId)).toEqual([
      'acme',
      'acme-22223333',
      'acme-111122223333',
      'workspace-111111111111111122223333',
    ])
    expect(hireWorkspaceSignInSlugHash('acme')).toMatch(/^[a-f0-9]{64}$/)
    expect(hireWorkspaceSignInSlugHash('acme')).not.toBe(
      hireWorkspaceSignInSlugHash('acme-2'),
    )
  })

  it('exports exact preparer-owned indexes without runtime auto-indexing', () => {
    expect({
      key: HIRE_WORKSPACE_SIGN_IN_SLUG_INDEX_KEY,
      name: HIRE_WORKSPACE_SIGN_IN_SLUG_INDEX_NAME,
      partial: HIRE_WORKSPACE_SIGN_IN_SLUG_INDEX_PARTIAL,
    }).toEqual({
      key: { signInSlug: 1 },
      name: 'uniq_hire_workspace_sign_in_slug',
      partial: { signInSlug: { $type: 'string' } },
    })
    expect({
      key: HIRE_WORKSPACE_SIGN_IN_RESERVATION_INDEX_KEY,
      name: HIRE_WORKSPACE_SIGN_IN_RESERVATION_INDEX_NAME,
      partial: HIRE_WORKSPACE_SIGN_IN_RESERVATION_INDEX_PARTIAL,
    }).toEqual({
      key: { workspaceId: 1 },
      name: 'uniq_hire_workspace_sign_in_reservation_workspace',
      partial: { state: 'active', workspaceId: { $type: 'objectId' } },
    })
    expect(HireWorkspaceSignInSlug.schema.indexes()).toContainEqual([
      { workspaceId: 1 },
      expect.objectContaining({
        name: HIRE_WORKSPACE_SIGN_IN_RESERVATION_INDEX_NAME,
        unique: true,
        partialFilterExpression: {
          state: 'active',
          workspaceId: { $type: 'objectId' },
        },
      }),
    ])
    expect(HireWorkspaceSignInSlug.schema.options.autoIndex).toBe(false)
  })
})
