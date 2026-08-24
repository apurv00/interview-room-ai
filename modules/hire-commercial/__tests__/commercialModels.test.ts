import mongoose from 'mongoose'
import { describe, expect, it } from 'vitest'
import {
  HIRE_COMMERCIAL_CATALOG_VERSION,
  HIRE_COMMERCIAL_MODULE_IDS,
} from '../catalog'
import { HireCommercialAccount } from '../models'

describe('Hire commercial shadow models', () => {
  it('validates a versioned account while leaving index creation to the explicit preparer', () => {
    const account = new HireCommercialAccount({
      workspaceId: new mongoose.Types.ObjectId(),
      catalogVersion: HIRE_COMMERCIAL_CATALOG_VERSION,
      entitledModules: HIRE_COMMERCIAL_MODULE_IDS,
      pilotStatus: 'not_requested',
    })
    expect(account.validateSync()).toBeUndefined()

    expect(HireCommercialAccount.schema.options.autoCreate).toBe(false)
    expect(HireCommercialAccount.schema.options.autoIndex).toBe(false)
    expect(HireCommercialAccount.schema.indexes()).toEqual([])
    expect(HireCommercialAccount.schema.path('workspaceId').isRequired).toBe(
      true,
    )
    expect(account.entitledModules).toEqual(HIRE_COMMERCIAL_MODULE_IDS)
    const normalized = new HireCommercialAccount({
      workspaceId: new mongoose.Types.ObjectId(),
      entitledModules: ['screen', 'screen'],
    })
    expect(normalized.entitledModules).toEqual(['core', 'screen'])
  })
})
