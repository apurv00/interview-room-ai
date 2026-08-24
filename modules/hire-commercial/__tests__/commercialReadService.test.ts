import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ForbiddenError } from '@shared/errors'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  accountFindOne: vi.fn(),
  resultAggregate: vi.fn(),
}))

vi.mock('@hire-operations-boundary', () => ({
  connectHireControlDB: mocks.connect,
  HireInterviewResult: { aggregate: mocks.resultAggregate },
}))
vi.mock('../models/HireCommercialAccount', () => ({
  HireCommercialAccount: { findOne: mocks.accountFindOne },
}))

import { readHireCommercialWorkspace } from '../services/commercialReadService'

function context(role: 'admin' | 'member' = 'admin') {
  return {
    workspace: { _id: '111111111111111111111111' },
    membership: { role },
  } as never
}

function accountQuery(value: unknown) {
  return { lean: vi.fn().mockResolvedValue(value) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue(undefined)
  mocks.accountFindOne.mockReturnValue(accountQuery(null))
  mocks.resultAggregate.mockResolvedValue([])
})

describe('Hire commercial admin projection', () => {
  it('defaults a missing account to all current capabilities with no lockout', async () => {
    const view = await readHireCommercialWorkspace(context())

    expect(view).toMatchObject({
      catalogVersion: 'hire-commercial-v1',
      enforcement: 'shadow',
      source: 'compatibility_default',
      pilotStatus: 'not_requested',
      usage: {
        screenAssessmentsCompleted: 0,
        measurementStartedAt: new Date('2026-08-23T00:00:00.000Z'),
        scope: 'shadow_era',
      },
    })
    expect(view.modules.map((module) => module.id)).toEqual([
      'core',
      'screen',
      'decide',
      'operate',
    ])
    expect(view.modules.every((module) => module.available)).toBe(true)
    expect(
      view.modules.every((module) => module.commercialState === 'included'),
    ).toBe(true)
    expect(mocks.accountFindOne).toHaveBeenCalledWith({
      workspaceId: '111111111111111111111111',
      catalogVersion: 'hire-commercial-v1',
    })
  })

  it('shows persisted shadow selections without turning them into access gates', async () => {
    mocks.accountFindOne.mockReturnValue(
      accountQuery({
        catalogVersion: 'hire-commercial-v1',
        entitledModules: ['screen'],
        pilotStatus: 'requested',
      }),
    )

    const view = await readHireCommercialWorkspace(context())

    expect(view.source).toBe('persisted_account')
    expect(view.pilotStatus).toBe('requested')
    expect(view.modules.find((module) => module.id === 'core')).toMatchObject({
      available: true,
      commercialState: 'included',
    })
    expect(view.modules.find((module) => module.id === 'decide')).toMatchObject({
      available: true,
      commercialState: 'not_selected',
    })
  })

  it('returns a count and first shadow observation without evidence coordinates', async () => {
    const measurementStartedAt = new Date('2026-08-23T00:00:00.000Z')
    mocks.resultAggregate.mockResolvedValue([
      { screenAssessmentsCompleted: 7 },
    ])

    const view = await readHireCommercialWorkspace(context())

    expect(view.usage).toEqual({
      screenAssessmentsCompleted: 7,
      measurementStartedAt,
      scope: 'shadow_era',
    })
    expect(mocks.resultAggregate).toHaveBeenCalledWith([
      {
        $match: {
          workspaceId: '111111111111111111111111',
          completedAt: { $gte: measurementStartedAt },
        },
      },
      { $count: 'screenAssessmentsCompleted' },
      { $project: { _id: 0 } },
    ])
    const dtoKeys = JSON.stringify({
      top: Object.keys(view),
      usage: Object.keys(view.usage),
      module: Object.keys(view.modules[0]),
    })
    expect(dtoKeys).not.toMatch(
      /evidenceResultId|candidateId|candidateEmail|applicationId|roundId|attemptId|contact/i,
    )
  })

  it('rejects non-admin members before connecting or reading an account', async () => {
    await expect(
      readHireCommercialWorkspace(context('member')),
    ).rejects.toBeInstanceOf(ForbiddenError)
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(mocks.accountFindOne).not.toHaveBeenCalled()
    expect(mocks.resultAggregate).not.toHaveBeenCalled()
  })
})
