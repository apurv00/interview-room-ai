import { describe, expect, it } from 'vitest'
import {
  AssignHireDepartmentSchema,
  CreateHireDepartmentSchema,
  UpdateHireDepartmentSchema,
} from '../validators/hireDepartments'

describe('Hire Department validators', () => {
  it('accepts only a normalized ordinary department create payload', () => {
    expect(CreateHireDepartmentSchema.parse({ name: '  People   Operations  ' })).toEqual({
      name: 'People Operations',
    })
    expect(() => CreateHireDepartmentSchema.parse({ name: 'Engineering', kind: 'legacy' })).toThrow()
  })

  it('requires a strict object-id assignment and explicit lifecycle action', () => {
    const departmentId = '111111111111111111111111'
    expect(AssignHireDepartmentSchema.parse({ departmentId })).toEqual({ departmentId })
    expect(UpdateHireDepartmentSchema.parse({ action: 'archive' })).toEqual({ action: 'archive' })
    expect(() => AssignHireDepartmentSchema.parse({ departmentId: 'not-an-id' })).toThrow()
    expect(() => UpdateHireDepartmentSchema.parse({ action: 'delete' })).toThrow()
  })
})
