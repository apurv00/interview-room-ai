import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(),
  indexes: vi.fn(),
  createIndex: vi.fn(),
}))

vi.mock('../../shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('../../shared/db/models', () => ({
  JobApplication: { collection: { indexes: mocks.indexes, createIndex: mocks.createIndex } },
}))

import {
  runTrackerStatusIndexPreparation,
  trackerStatusIndexModeOf,
} from '../prepare-jobs-tracker-status-index'
import {
  TRACKER_STATUS_SWEEP_INDEX_KEY,
  TRACKER_STATUS_SWEEP_INDEX_NAME,
  TRACKER_STATUS_SWEEP_INDEX_PARTIAL,
} from '../../modules/jobs/services/trackerStatusSweepService'

const exactIndex = {
  name: TRACKER_STATUS_SWEEP_INDEX_NAME,
  key: TRACKER_STATUS_SWEEP_INDEX_KEY,
  partialFilterExpression: TRACKER_STATUS_SWEEP_INDEX_PARTIAL,
}

describe('Jobs tracker-status index rollout gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.connectDB.mockResolvedValue(undefined)
    mocks.createIndex.mockResolvedValue(TRACKER_STATUS_SWEEP_INDEX_NAME)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })
  afterEach(() => vi.restoreAllMocks())

  it.each([
    [[], 'plan'],
    [['--apply'], 'apply'],
    [['--check'], 'check'],
  ] as const)('parses %j as %s', (argv, expected) => {
    expect(trackerStatusIndexModeOf([...argv])).toBe(expected)
  })

  it('keeps the default plan disconnected and read-only', async () => {
    await runTrackerStatusIndexPreparation([])
    expect(mocks.connectDB).not.toHaveBeenCalled()
    expect(mocks.indexes).not.toHaveBeenCalled()
    expect(mocks.createIndex).not.toHaveBeenCalled()
  })

  it('fails the read-only check when the exact index is absent', async () => {
    mocks.indexes.mockResolvedValue([{ name: '_id_', key: { _id: 1 } }])
    await expect(runTrackerStatusIndexPreparation(['--check']))
      .rejects.toThrow(TRACKER_STATUS_SWEEP_INDEX_NAME)
    expect(mocks.createIndex).not.toHaveBeenCalled()
  })

  it('creates and re-verifies the exact index without dropping anything', async () => {
    mocks.indexes
      .mockResolvedValueOnce([{ name: '_id_', key: { _id: 1 } }])
      .mockResolvedValueOnce([{ name: '_id_', key: { _id: 1 } }, exactIndex])

    await runTrackerStatusIndexPreparation(['--apply'])

    expect(mocks.createIndex).toHaveBeenCalledWith(TRACKER_STATUS_SWEEP_INDEX_KEY, {
      name: TRACKER_STATUS_SWEEP_INDEX_NAME,
      partialFilterExpression: TRACKER_STATUS_SWEEP_INDEX_PARTIAL,
    })
    expect(mocks.indexes).toHaveBeenCalledTimes(2)
  })

  it('fails closed on a key-identical incompatible index', async () => {
    mocks.indexes.mockResolvedValue([{
      name: 'legacy_due_index',
      key: TRACKER_STATUS_SWEEP_INDEX_KEY,
      partialFilterExpression: { status: 'applied' },
    }])

    await expect(runTrackerStatusIndexPreparation(['--apply']))
      .rejects.toThrow('incompatible tracker-status index legacy_due_index')
    expect(mocks.createIndex).not.toHaveBeenCalled()
  })
})
