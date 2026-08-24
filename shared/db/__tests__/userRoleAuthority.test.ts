import { describe, expect, it } from 'vitest'
import { User } from '../models/User'

describe('User persistent role authority', () => {
  it('accepts only candidate and platform administrator roles', () => {
    const rolePath = User.schema.path('role')

    expect(rolePath.options.enum).toEqual(['candidate', 'platform_admin'])
    expect(new User({
      email: 'candidate@example.invalid',
      name: 'Candidate',
      role: 'candidate',
    }).validateSync()?.errors.role).toBeUndefined()
    expect(new User({
      email: 'admin@example.invalid',
      name: 'Administrator',
      role: 'platform_admin',
    }).validateSync()?.errors.role).toBeUndefined()
  })

  it.each(['recruiter', 'org_admin', 'unknown_role'])(
    'rejects the retired or unknown %s role',
    (role) => {
      const error = new User({
        email: `${role}@example.invalid`,
        name: 'Retired role',
        role,
      }).validateSync()

      expect(error?.errors.role).toMatchObject({ kind: 'enum' })
    },
  )
})
