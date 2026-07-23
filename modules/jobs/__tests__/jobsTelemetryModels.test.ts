import { describe, expect, it } from 'vitest'
import { JobIngestCycle } from '@shared/db/models/JobIngestCycle'
import { JobSourceConfig } from '@shared/db/models/JobSourceConfig'

describe('Jobs telemetry model contracts', () => {
  it('does not advertise unsupported ingest-cycle metrics', () => {
    expect(JobIngestCycle.schema.path('dupCollapsedPct')).toBeUndefined()
    expect(JobIngestCycle.schema.path('stubRate')).toBeUndefined()
  })

  it('does not advertise an unwritten source failure streak', () => {
    expect(JobSourceConfig.schema.path('failStreak')).toBeUndefined()
  })
})
