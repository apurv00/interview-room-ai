import { describe, expect, it } from 'vitest'
import {
  assertNoHireMemberEmailConflicts,
  hireMemberEmailMigrationModeOf,
  isExactHireMemberActiveEmailIndex,
  workspaceActiveEmailConflictPipeline,
  workspaceCredentialIssueFilter,
  workspaceMemberIdentityIssueFilter,
  workspaceNormalizedEmailIssueFilter,
} from '../prepare-hire-member-email-uniqueness'

describe('Hire member email migration gate', () => {
  it('is plan-only unless apply/check is explicit', () => {
    expect(hireMemberEmailMigrationModeOf([])).toBe('plan')
    expect(hireMemberEmailMigrationModeOf(['--apply'])).toBe('apply')
    expect(hireMemberEmailMigrationModeOf(['--check'])).toBe('check')
    expect(() =>
      hireMemberEmailMigrationModeOf(['--apply', '--check']),
    ).toThrow()
  })

  it('rejects historical ambiguity without auto-merging memberships', () => {
    expect(() =>
      assertNoHireMemberEmailConflicts([
        {
          _id: {
            workspaceId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
            normalizedEmail: 'member@example.com',
          },
          count: 2,
          memberIds: [
            '111111111111111111111111',
            '222222222222222222222222',
          ] as never,
        },
      ]),
    ).toThrow(/conflicts=1/)
  })

  it('requires the exact named unique partial index contract', () => {
    expect(
      isExactHireMemberActiveEmailIndex({
        name: 'hire_member_workspace_pending_active_normalized_email_unique',
        key: { workspaceId: 1, normalizedEmail: 1 },
        unique: true,
        partialFilterExpression: { authState: { $in: ['pending', 'active'] } },
      }),
    ).toBe(true)
    expect(
      isExactHireMemberActiveEmailIndex({
        name: 'hire_member_workspace_pending_active_normalized_email_unique',
        key: { workspaceId: 1, normalizedEmail: 1 },
        unique: false,
        partialFilterExpression: { authState: { $in: ['pending', 'active'] } },
      }),
    ).toBe(false)
  })

  it('anchors every child-collection data read to an enumerated workspace', () => {
    const workspaceId = 'aaaaaaaaaaaaaaaaaaaaaaaa'

    expect(workspaceActiveEmailConflictPipeline(workspaceId)[0]).toEqual({
      $match: {
        workspaceId,
        authState: { $in: ['pending', 'active'] },
      },
    })
    expect(workspaceMemberIdentityIssueFilter(workspaceId)).toMatchObject({
      workspaceId,
    })
    expect(workspaceCredentialIssueFilter(workspaceId)).toMatchObject({
      workspaceId,
    })
    expect(workspaceNormalizedEmailIssueFilter(workspaceId)).toMatchObject({
      workspaceId,
    })
  })
})
