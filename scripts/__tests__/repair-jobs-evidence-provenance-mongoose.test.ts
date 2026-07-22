import mongoose from 'mongoose'
import { describe, expect, it } from 'vitest'
import { JobApplication } from '../../shared/db/models/JobApplication'
import { readinessRemovalUpdate } from '../repair-jobs-evidence-provenance'

describe('Jobs evidence repair Mongoose compatibility', () => {
  it('casts the revision CAS and standard update without update-pipeline mode', () => {
    const query = JobApplication.updateOne(
      {
        _id: new mongoose.Types.ObjectId(),
        readiness: { $exists: true },
        readinessRevision: 7,
      },
      readinessRemovalUpdate(),
    )

    expect(() => query.cast(JobApplication)).not.toThrow()
    expect(Array.isArray(query.getUpdate())).toBe(false)
    expect(query.getUpdate()).toEqual({
      $unset: { readiness: 1 },
      $inc: { readinessRevision: 1 },
    })
  })

  it('demonstrates why malformed persisted revisions are refused before writes', () => {
    const query = JobApplication.updateOne(
      { _id: new mongoose.Types.ObjectId(), readinessRevision: 'bad' },
      readinessRemovalUpdate(),
    )

    expect(() => query.cast(JobApplication)).toThrow(/readinessRevision/)
  })
})
