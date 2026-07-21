import { describe, expect, it } from 'vitest'
import { Types } from 'mongoose'
import {
  JOBS_TRACKER_SWEEP_CURSOR_ID,
  TrackerStatusSweepCursor,
} from '../models/TrackerStatusSweepCursor'

describe('TrackerStatusSweepCursor', () => {
  it('stores only the global tuple continuation required by the bounded scan', () => {
    const cursor = new TrackerStatusSweepCursor({
      _id: JOBS_TRACKER_SWEEP_CURSOR_ID,
      appliedAt: new Date('2026-06-16T12:00:00.000Z'),
      applicationId: new Types.ObjectId(),
      lastRunAt: new Date('2026-07-21T12:00:00.000Z'),
    })

    expect(cursor.validateSync()).toBeUndefined()
    expect(TrackerStatusSweepCursor.collection.collectionName)
      .toBe('jobs_tracker_status_sweep_cursors')
    expect(TrackerStatusSweepCursor.schema.path('userId')).toBeUndefined()
    expect(TrackerStatusSweepCursor.schema.path('applicationId')?.isRequired).toBe(true)
  })
})
