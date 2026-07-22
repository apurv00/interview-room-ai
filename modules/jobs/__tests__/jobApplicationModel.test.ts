import { describe, expect, it } from 'vitest'
import { JobApplication } from '@shared/db/models/JobApplication'
import {
  TRACKER_STATUS_SWEEP_INDEX_KEY,
  TRACKER_STATUS_SWEEP_INDEX_NAME,
  TRACKER_STATUS_SWEEP_INDEX_PARTIAL,
} from '../services/trackerStatusSweepService'

describe('JobApplication tracker sweep index', () => {
  it('supports the interviewed lifecycle state and additive canonical outcome fields', () => {
    const status = JobApplication.schema.path('status') as unknown as {
      options: { enum: string[] }
    }
    const result = JobApplication.schema.path('outcome.latestResult') as unknown as {
      options: { enum: string[] }
    }
    const rounds = JobApplication.schema.path('outcome.interviewRounds') as unknown as {
      options: { default?: number; min?: number }
    }
    const revision = JobApplication.schema.path('outcome.revision') as unknown as {
      options: { default?: number; min?: number }
    }

    expect(status.options.enum).toContain('interviewed')
    expect(result.options.enum).toEqual(['advanced', 'waiting', 'rejected', 'offer'])
    expect(rounds.options).toMatchObject({ default: 0, min: 0 })
    expect(revision.options).toMatchObject({ default: 0, min: 0 })
    for (const path of [
      'outcome.latestRound',
      'outcome.latestReportedAt',
      'outcome.lastInterviewedAt',
      'outcome.lastDeferredRound',
    ]) {
      expect(JobApplication.schema.path(path)).toBeDefined()
    }
  })

  it('keeps the derived-authority transaction token private', () => {
    const path = JobApplication.schema.path('derivedAuthorityRevision')

    expect(path).toBeDefined()
    expect((path?.options as { select?: boolean; default?: number }).select).toBe(false)
    expect((path?.options as { select?: boolean; default?: number }).default).toBe(0)
  })

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

  it('stores coarse interview timing separately from an exact date', () => {
    const path = JobApplication.schema.path('interviewDatePreference') as unknown as {
      options: { enum: string[] }
    }

    expect(path.options.enum).toEqual(['this-week', 'next-week', 'unknown'])
  })

  it('persists bounded-shape trusted opens and incident-bound report metadata', () => {
    const attempts = JobApplication.schema.path('applyOpenAttempts') as unknown as {
      schema: { path: (name: string) => { instance?: string; options?: Record<string, unknown> } | undefined }
    }
    const reports = JobApplication.schema.path('brokenLinkReports') as unknown as {
      schema: { path: (name: string) => { instance?: string; options?: Record<string, unknown> } | undefined }
    }

    expect(attempts.schema.path('subject')?.options).toMatchObject({ required: true, maxlength: 64 })
    expect(attempts.schema.path('generation')?.options).toMatchObject({ required: true, maxlength: 64 })
    expect(attempts.schema.path('incidentVersion')?.options).toMatchObject({ required: true, min: 1 })
    expect(attempts.schema.path('openedAt')?.instance).toBe('Date')
    expect(reports.schema.path('disposition')?.options?.enum).toEqual([
      'pending-verification', 'crowd-demoted', 'machine-demoted',
    ])
  })
})
