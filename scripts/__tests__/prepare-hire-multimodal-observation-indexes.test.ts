import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(),
  controlAnalysisIndexes: vi.fn(),
  controlAnalysisCreateIndex: vi.fn(),
  controlAnalysisAggregate: vi.fn(),
  controlAnalysisEventIndexes: vi.fn(),
  controlAnalysisEventCreateIndex: vi.fn(),
  controlAnalysisEventAggregate: vi.fn(),
  controlObservationIndexes: vi.fn(),
  controlObservationCreateIndex: vi.fn(),
  controlObservationAggregate: vi.fn(),
  controlEventIndexes: vi.fn(),
  controlEventCreateIndex: vi.fn(),
  controlEventAggregate: vi.fn(),
  controlPurgeObligationIndexes: vi.fn(),
  controlPurgeObligationCreateIndex: vi.fn(),
  controlPurgeObligationAggregate: vi.fn(),
  runtimeIndexes: vi.fn(),
  runtimeCreateIndex: vi.fn(),
  runtimeAggregate: vi.fn(),
  runtimeAnalysisIndexes: vi.fn(),
  runtimeAnalysisCreateIndex: vi.fn(),
  runtimeAnalysisAggregate: vi.fn(),
  runtimeBindingIndexes: vi.fn(),
  runtimeBindingCreateIndex: vi.fn(),
  runtimeBindingAggregate: vi.fn(),
  runtimeTombstoneIndexes: vi.fn(),
  runtimeTombstoneCreateIndex: vi.fn(),
  runtimeTombstoneAggregate: vi.fn(),
}))

vi.mock('../../shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('../../modules/hire-multimodal/models', () => ({
  HireMultimodalAnalysis: {
    collection: {
      indexes: mocks.controlAnalysisIndexes,
      createIndex: mocks.controlAnalysisCreateIndex,
      aggregate: mocks.controlAnalysisAggregate,
    },
  },
  HireMultimodalAnalysisIngestionEvent: {
    collection: {
      indexes: mocks.controlAnalysisEventIndexes,
      createIndex: mocks.controlAnalysisEventCreateIndex,
      aggregate: mocks.controlAnalysisEventAggregate,
    },
  },
  HireMultimodalObservation: {
    collection: {
      indexes: mocks.controlObservationIndexes,
      createIndex: mocks.controlObservationCreateIndex,
      aggregate: mocks.controlObservationAggregate,
    },
  },
  HireMultimodalObservationIngestionEvent: {
    collection: {
      indexes: mocks.controlEventIndexes,
      createIndex: mocks.controlEventCreateIndex,
      aggregate: mocks.controlEventAggregate,
    },
  },
  HireMultimodalObservationPurgeObligation: {
    collection: {
      indexes: mocks.controlPurgeObligationIndexes,
      createIndex: mocks.controlPurgeObligationCreateIndex,
      aggregate: mocks.controlPurgeObligationAggregate,
    },
  },
}))
vi.mock('../../modules/hire-runtime/models/HireRuntimeMultimodalObservationOutbox', () => ({
  HireRuntimeMultimodalObservationOutbox: {
    collection: {
      indexes: mocks.runtimeIndexes,
      createIndex: mocks.runtimeCreateIndex,
      aggregate: mocks.runtimeAggregate,
    },
  },
}))
vi.mock('../../modules/hire-runtime/models/HireRuntimeMultimodalAnalysisOutbox', () => ({
  HireRuntimeMultimodalAnalysisOutbox: {
    collection: {
      indexes: mocks.runtimeAnalysisIndexes,
      createIndex: mocks.runtimeAnalysisCreateIndex,
      aggregate: mocks.runtimeAnalysisAggregate,
    },
  },
}))
vi.mock('../../modules/hire-runtime/models/HireRuntimeBinding', () => ({
  HireRuntimeBinding: {
    collection: {
      indexes: mocks.runtimeBindingIndexes,
      createIndex: mocks.runtimeBindingCreateIndex,
      aggregate: mocks.runtimeBindingAggregate,
    },
  },
}))
vi.mock('../../modules/hire-runtime/models/HireRuntimeMultimodalObservationRetentionTombstone', () => ({
  HireRuntimeMultimodalObservationRetentionTombstone: {
    collection: {
      indexes: mocks.runtimeTombstoneIndexes,
      createIndex: mocks.runtimeTombstoneCreateIndex,
      aggregate: mocks.runtimeTombstoneAggregate,
    },
  },
}))

import mongoose from 'mongoose'
import {
  HIRE_MULTIMODAL_OBSERVATION_INDEX_DEFINITIONS,
  hireMultimodalObservationIndexPreparationModeOf,
  isExactHireMultimodalObservationIndex,
  prepareHireMultimodalObservationIndexes,
} from '../prepare-hire-multimodal-observation-indexes'

type Target = (typeof HIRE_MULTIMODAL_OBSERVATION_INDEX_DEFINITIONS)[number]['target']

const byTarget = {
  'control-analyses': {
    indexes: mocks.controlAnalysisIndexes,
    createIndex: mocks.controlAnalysisCreateIndex,
    aggregate: mocks.controlAnalysisAggregate,
  },
  'control-analysis-ingestion-events': {
    indexes: mocks.controlAnalysisEventIndexes,
    createIndex: mocks.controlAnalysisEventCreateIndex,
    aggregate: mocks.controlAnalysisEventAggregate,
  },
  'control-observations': {
    indexes: mocks.controlObservationIndexes,
    createIndex: mocks.controlObservationCreateIndex,
    aggregate: mocks.controlObservationAggregate,
  },
  'control-ingestion-events': {
    indexes: mocks.controlEventIndexes,
    createIndex: mocks.controlEventCreateIndex,
    aggregate: mocks.controlEventAggregate,
  },
  'control-runtime-purge-obligations': {
    indexes: mocks.controlPurgeObligationIndexes,
    createIndex: mocks.controlPurgeObligationCreateIndex,
    aggregate: mocks.controlPurgeObligationAggregate,
  },
  'runtime-outbox': {
    indexes: mocks.runtimeIndexes,
    createIndex: mocks.runtimeCreateIndex,
    aggregate: mocks.runtimeAggregate,
  },
  'runtime-analysis-outbox': {
    indexes: mocks.runtimeAnalysisIndexes,
    createIndex: mocks.runtimeAnalysisCreateIndex,
    aggregate: mocks.runtimeAnalysisAggregate,
  },
  'runtime-bindings': {
    indexes: mocks.runtimeBindingIndexes,
    createIndex: mocks.runtimeBindingCreateIndex,
    aggregate: mocks.runtimeBindingAggregate,
  },
  'runtime-retention-tombstones': {
    indexes: mocks.runtimeTombstoneIndexes,
    createIndex: mocks.runtimeTombstoneCreateIndex,
    aggregate: mocks.runtimeTombstoneAggregate,
  },
} as const

function exactIndexes(target: Target) {
  return HIRE_MULTIMODAL_OBSERVATION_INDEX_DEFINITIONS.filter(
    (definition) => definition.target === target,
  ).map((definition) => ({
    name: definition.name,
    key: definition.key,
    ...(definition.unique ? { unique: true } : {}),
  }))
}

function setExactIndexes() {
  for (const target of Object.keys(byTarget) as Target[]) {
    byTarget[target].indexes.mockResolvedValue(exactIndexes(target))
  }
}

function setMissingThenExact(target: Target) {
  byTarget[target].indexes
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce(exactIndexes(target))
}

function setNoDuplicates() {
  for (const target of Object.keys(byTarget) as Target[]) {
    byTarget[target].aggregate.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) })
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  process.env.IPG_SURFACE = 'hire-control'
  process.env.HIRE_CONTROL_DATABASE_NAME = 'hire-control'
  process.env.HIRE_RUNTIME_DATABASE_NAME = 'hire-runtime'
  mocks.connectDB.mockResolvedValue(undefined)
  Object.defineProperty(mongoose.connection, 'name', {
    configurable: true,
    value: 'hire-control',
  })
  for (const target of Object.keys(byTarget) as Target[]) {
    byTarget[target].createIndex.mockImplementation(async (_key, options) => options.name)
  }
  setNoDuplicates()
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.IPG_SURFACE
  delete process.env.HIRE_CONTROL_DATABASE_NAME
  delete process.env.HIRE_RUNTIME_DATABASE_NAME
})

describe('Hire-native multimodal index preparation', () => {
  it('plans without connecting and rejects unsafe flags', async () => {
    expect(hireMultimodalObservationIndexPreparationModeOf([])).toBe('plan')
    expect(hireMultimodalObservationIndexPreparationModeOf(['--check'])).toBe('check')
    expect(() =>
      hireMultimodalObservationIndexPreparationModeOf(['--apply', '--check']),
    ).toThrow('mutually exclusive')

    await prepareHireMultimodalObservationIndexes([])

    expect(mocks.connectDB).not.toHaveBeenCalled()
  })

  it('checks only the control-plane collections on the control surface', async () => {
    setExactIndexes()

    await prepareHireMultimodalObservationIndexes(['--check'])

    expect(mocks.connectDB).toHaveBeenCalledOnce()
    expect(mocks.controlAnalysisIndexes).toHaveBeenCalledOnce()
    expect(mocks.controlAnalysisEventIndexes).toHaveBeenCalledOnce()
    expect(mocks.controlObservationIndexes).toHaveBeenCalledOnce()
    expect(mocks.controlEventIndexes).toHaveBeenCalledOnce()
    expect(mocks.controlPurgeObligationIndexes).toHaveBeenCalledOnce()
    expect(mocks.runtimeAnalysisIndexes).not.toHaveBeenCalled()
    expect(mocks.runtimeBindingIndexes).not.toHaveBeenCalled()
    expect(mocks.runtimeIndexes).not.toHaveBeenCalled()
    expect(mocks.runtimeTombstoneIndexes).not.toHaveBeenCalled()
  })

  it('checks only runtime-native collections on the runtime surface', async () => {
    process.env.IPG_SURFACE = 'hire-engine'
    Object.defineProperty(mongoose.connection, 'name', {
      configurable: true,
      value: 'hire-runtime',
    })
    setExactIndexes()

    await prepareHireMultimodalObservationIndexes(['--check'])

    expect(mocks.runtimeAnalysisIndexes).toHaveBeenCalledOnce()
    expect(mocks.runtimeBindingIndexes).toHaveBeenCalledOnce()
    expect(mocks.runtimeIndexes).toHaveBeenCalledOnce()
    expect(mocks.runtimeTombstoneIndexes).toHaveBeenCalledOnce()
    expect(mocks.controlAnalysisIndexes).not.toHaveBeenCalled()
    expect(mocks.controlAnalysisEventIndexes).not.toHaveBeenCalled()
    expect(mocks.controlObservationIndexes).not.toHaveBeenCalled()
    expect(mocks.controlEventIndexes).not.toHaveBeenCalled()
    expect(mocks.controlPurgeObligationIndexes).not.toHaveBeenCalled()
  })

  it('creates only the missing control indexes after checking every unique invariant', async () => {
    setMissingThenExact('control-analyses')
    setMissingThenExact('control-analysis-ingestion-events')
    setMissingThenExact('control-observations')
    setMissingThenExact('control-ingestion-events')
    setMissingThenExact('control-runtime-purge-obligations')

    await prepareHireMultimodalObservationIndexes(['--apply'])

    const controlDefinitions = HIRE_MULTIMODAL_OBSERVATION_INDEX_DEFINITIONS.filter(
      (definition) => definition.target.startsWith('control-'),
    )
    expect(mocks.controlAnalysisCreateIndex).toHaveBeenCalledTimes(
      controlDefinitions.filter((definition) => definition.target === 'control-analyses').length,
    )
    expect(mocks.controlAnalysisEventCreateIndex).toHaveBeenCalledTimes(
      controlDefinitions.filter(
        (definition) => definition.target === 'control-analysis-ingestion-events',
      ).length,
    )
    expect(mocks.controlObservationCreateIndex).toHaveBeenCalledTimes(
      controlDefinitions.filter((definition) => definition.target === 'control-observations').length,
    )
    expect(mocks.controlEventCreateIndex).toHaveBeenCalledTimes(
      controlDefinitions.filter((definition) => definition.target === 'control-ingestion-events').length,
    )
    expect(mocks.controlPurgeObligationCreateIndex).toHaveBeenCalledTimes(
      controlDefinitions.filter(
        (definition) => definition.target === 'control-runtime-purge-obligations',
      ).length,
    )
    expect(mocks.controlObservationAggregate).toHaveBeenCalledTimes(
      controlDefinitions.filter(
        (definition) => definition.target === 'control-observations' && definition.unique,
      ).length,
    )
    expect(mocks.runtimeCreateIndex).not.toHaveBeenCalled()
    expect(mocks.runtimeTombstoneCreateIndex).not.toHaveBeenCalled()
  })

  it('creates all missing runtime indexes, including late camera/display recovery', async () => {
    process.env.IPG_SURFACE = 'hire-engine'
    Object.defineProperty(mongoose.connection, 'name', {
      configurable: true,
      value: 'hire-runtime',
    })
    setMissingThenExact('runtime-analysis-outbox')
    setMissingThenExact('runtime-bindings')
    setMissingThenExact('runtime-outbox')
    setMissingThenExact('runtime-retention-tombstones')

    await prepareHireMultimodalObservationIndexes(['--apply'])

    const runtimeDefinitions = HIRE_MULTIMODAL_OBSERVATION_INDEX_DEFINITIONS.filter(
      (definition) => definition.target.startsWith('runtime-'),
    )
    expect(mocks.runtimeAnalysisCreateIndex).toHaveBeenCalledTimes(
      runtimeDefinitions.filter((definition) => definition.target === 'runtime-analysis-outbox').length,
    )
    expect(mocks.runtimeBindingCreateIndex).toHaveBeenCalledTimes(
      runtimeDefinitions.filter((definition) => definition.target === 'runtime-bindings').length,
    )
    expect(mocks.runtimeCreateIndex).toHaveBeenCalledTimes(
      runtimeDefinitions.filter((definition) => definition.target === 'runtime-outbox').length,
    )
    expect(mocks.runtimeTombstoneCreateIndex).toHaveBeenCalledTimes(
      runtimeDefinitions.filter(
        (definition) => definition.target === 'runtime-retention-tombstones',
      ).length,
    )
    expect(mocks.controlAnalysisCreateIndex).not.toHaveBeenCalled()
    expect(mocks.controlObservationCreateIndex).not.toHaveBeenCalled()
  })

  it('refuses a same-key incompatible index without writing', async () => {
    mocks.controlObservationIndexes.mockResolvedValue([
      {
        name: 'wrong',
        key: HIRE_MULTIMODAL_OBSERVATION_INDEX_DEFINITIONS[0].key,
        unique: false,
      },
    ])
    mocks.controlEventIndexes.mockResolvedValue(exactIndexes('control-ingestion-events'))

    await expect(
      prepareHireMultimodalObservationIndexes(['--apply']),
    ).rejects.toThrow('incompatible same-key')
    expect(mocks.controlObservationCreateIndex).not.toHaveBeenCalled()
    expect(mocks.controlEventCreateIndex).not.toHaveBeenCalled()
  })

  it('requires the exact schema index shape', () => {
    const definition = HIRE_MULTIMODAL_OBSERVATION_INDEX_DEFINITIONS[0]
    expect(
      isExactHireMultimodalObservationIndex(
        { name: definition.name, key: definition.key, unique: true },
        definition,
      ),
    ).toBe(true)
    expect(
      isExactHireMultimodalObservationIndex(
        { name: definition.name, key: definition.key, unique: false },
        definition,
      ),
    ).toBe(false)
  })
})
