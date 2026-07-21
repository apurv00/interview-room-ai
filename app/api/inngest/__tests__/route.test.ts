import { describe, expect, it, vi } from 'vitest'

const { mockServe, retentionJob, sourceValidateJob, trackerStatusSweepJob } = vi.hoisted(() => ({
  mockServe: vi.fn(() => ({ GET: vi.fn(), POST: vi.fn(), PUT: vi.fn() })),
  retentionJob: { id: 'retention-sentinel' },
  sourceValidateJob: { id: 'source-validate-sentinel' },
  trackerStatusSweepJob: { id: 'tracker-status-sweep-sentinel' },
}))

vi.mock('inngest/next', () => ({ serve: mockServe }))
vi.mock('@shared/services/inngest', () => ({ inngest: { id: 'client' } }))
vi.mock('@interview/jobs/analysisJob', () => ({ analysisJob: { id: 'analysis' } }))
vi.mock('@interview/jobs/enrichFeedbackJob', () => ({ enrichFeedbackJob: { id: 'feedback' } }))
vi.mock('@learn/jobs/emailDigestJob', () => ({ emailDigestJob: { id: 'digest' } }))
vi.mock('@learn/jobs/regeneratePlansJob', () => ({ regeneratePlansJob: { id: 'plans' } }))
vi.mock('@learn/jobs/keepMongoWarm', () => ({ keepMongoWarmJob: { id: 'warm' } }))
vi.mock('@interview/jobs/recordingRetentionJob', () => ({ recordingRetentionJob: { id: 'recording-retention' } }))
vi.mock('@learn/jobs/pathwayJob', () => ({ pathwayJob: { id: 'pathway' } }))
vi.mock('@jobs/jobs/ingestJobs', () => ({
  jobsIngestSchedulerJob: { id: 'ingest' },
  jobsSourceSyncJob: { id: 'sync' },
  jobsSourceValidateJob: sourceValidateJob,
  jobsBoardProbeJob: { id: 'board' },
}))
vi.mock('@jobs/jobs/evaluatePostingsJob', () => ({
  jobsEvaluatePostingsJob: { id: 'evaluate' },
  jobsVerdictSweeperJob: { id: 'verdict' },
}))
vi.mock('@jobs/jobs/atsCheckJob', () => ({ jobsAtsCheckJob: { id: 'ats' } }))
vi.mock('@jobs/jobs/emailJobs', () => ({
  jobsEmailE0Job: { id: 'email-e0' },
  jobsEmailSweepJob: { id: 'email-sweep' },
}))
vi.mock('@jobs/jobs/evidenceAttributionJob', () => ({
  jobsEvidenceAttributionJob: { id: 'evidence' },
  jobsEvidenceReconcileJob: { id: 'evidence-reconcile' },
}))
vi.mock('@jobs/jobs/linkCheckJobs', () => ({ jobsLinkCheckJob: { id: 'link-check' } }))
vi.mock('@jobs/jobs/retentionSweepJob', () => ({ jobsRetentionSweepJob: retentionJob }))
vi.mock('@jobs/jobs/trackerStatusSweepJob', () => ({ jobsTrackerStatusSweepJob: trackerStatusSweepJob }))

import '../route'

describe('Inngest route registration', () => {
  it('serves the Jobs retention sweep exactly once', () => {
    expect(mockServe).toHaveBeenCalledOnce()
    const options = mockServe.mock.calls[0][0] as { functions: unknown[] }
    expect(options.functions.filter((fn) => fn === retentionJob)).toHaveLength(1)
  })

  it('serves the Jobs tracker status sweep exactly once', () => {
    expect(mockServe).toHaveBeenCalledOnce()
    const options = mockServe.mock.calls[0][0] as { functions: unknown[] }
    expect(options.functions.filter((fn) => fn === trackerStatusSweepJob)).toHaveLength(1)
  })

  it('serves the Jobs source validation worker exactly once', () => {
    expect(mockServe).toHaveBeenCalledOnce()
    const options = mockServe.mock.calls[0][0] as { functions: unknown[] }
    expect(options.functions.filter((fn) => fn === sourceValidateJob)).toHaveLength(1)
  })
})
