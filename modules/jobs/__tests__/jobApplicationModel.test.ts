import { describe, expect, it } from 'vitest'
import { JobApplication } from '@shared/db/models/JobApplication'
import {
  TRACKER_STATUS_SWEEP_INDEX_KEY,
  TRACKER_STATUS_SWEEP_INDEX_NAME,
  TRACKER_STATUS_SWEEP_INDEX_PARTIAL,
} from '../services/trackerStatusSweepService'

describe('JobApplication tracker sweep index', () => {
  it('indexes only confirmed applications by due time', () => {
    const dueIndex = JobApplication.schema.indexes().find(
      ([, options]) => options.name === TRACKER_STATUS_SWEEP_INDEX_NAME,
    )

    expect(dueIndex).toEqual([
      TRACKER_STATUS_SWEEP_INDEX_KEY,
      {
        name: TRACKER_STATUS_SWEEP_INDEX_NAME,
        partialFilterExpression: TRACKER_STATUS_SWEEP_INDEX_PARTIAL,
      },
    ])
  })
})
