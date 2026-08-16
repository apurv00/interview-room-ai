import mongoose, { type Model } from 'mongoose'
import { describe, expect, it } from 'vitest'
import {
  HireDepartment,
  HIRE_SYSTEM_DEPARTMENT_NAMES,
} from '../models/HireDepartment'

function indexes(model: Model<never>): Array<[Record<string, number>, Record<string, unknown>]> {
  return model.schema.indexes() as Array<[Record<string, number>, Record<string, unknown>]>
}

describe('HireDepartment schema', () => {
  it('is workspace-owned with stable catalog and system coordinates', () => {
    for (const pathName of ['workspaceId', 'normalizedName', 'kind', 'systemKey']) {
      const path = HireDepartment.schema.path(pathName)
      expect(path).toBeDefined()
      expect((path.options as { immutable?: boolean }).immutable).toBe(true)
    }
    expect(HireDepartment.schema.path('workspaceId').isRequired).toBe(true)
    expect(HireDepartment.schema.path('status').isRequired).toBe(true)
  })

  it('makes name uniqueness workspace-scoped and system rows one-per-kind', () => {
    const schemaIndexes = indexes(HireDepartment as unknown as Model<never>)
    const name = schemaIndexes.find(
      ([spec]) => spec.workspaceId === 1 && spec.normalizedName === 1,
    )
    const system = schemaIndexes.find(
      ([spec]) => spec.workspaceId === 1 && spec.systemKey === 1,
    )
    const catalogList = schemaIndexes.find(
      ([spec]) =>
        spec.workspaceId === 1 &&
        spec.status === 1 &&
        spec.kind === 1 &&
        spec.name === 1,
    )
    expect(name?.[1].unique).toBe(true)
    expect(system?.[1]).toMatchObject({
      unique: true,
      partialFilterExpression: { systemKey: { $exists: true } },
    })
    expect(catalogList?.[0]).toEqual({ workspaceId: 1, status: 1, kind: 1, name: 1 })
  })

  it('does not let a standard catalog row claim a system key', () => {
    const invalid = new HireDepartment({
      workspaceId: new mongoose.Types.ObjectId(),
      name: 'Engineering',
      normalizedName: 'engineering',
      kind: 'standard',
      systemKey: 'legacy',
    }).validateSync()
    expect(invalid?.errors.systemKey).toBeDefined()

    expect(HIRE_SYSTEM_DEPARTMENT_NAMES.legacy).toBe('Unclassified legacy jobs')
  })
})
