import { serve } from 'inngest/next'
import { inngest } from '@shared/services/inngest'
import { analysisJob } from '@interview/jobs/analysisJob'
import { enrichFeedbackJob } from '@interview/jobs/enrichFeedbackJob'
import { emailDigestJob } from '@learn/jobs/emailDigestJob'
import { regeneratePlansJob } from '@learn/jobs/regeneratePlansJob'
import { keepMongoWarmJob } from '@learn/jobs/keepMongoWarm'
import { recordingRetentionJob } from '@interview/jobs/recordingRetentionJob'
import { pathwayJob } from '@learn/jobs/pathwayJob'
import { jobsIngestSchedulerJob, jobsSourceSyncJob, jobsSourceValidateJob, jobsBoardProbeJob } from '@jobs/jobs/ingestJobs'
import { jobsEvaluatePostingsJob, jobsVerdictSweeperJob } from '@jobs/jobs/evaluatePostingsJob'
import { jobsAtsCheckJob } from '@jobs/jobs/atsCheckJob'
import { jobsEmailE0Job, jobsEmailSweepJob } from '@jobs/jobs/emailJobs'
import { jobsEvidenceAttributionJob, jobsEvidenceReconcileJob } from '@jobs/jobs/evidenceAttributionJob'
import { jobsLinkCheckJob } from '@jobs/jobs/linkCheckJobs'
import { jobsRetentionSweepJob } from '@jobs/jobs/retentionSweepJob'
import { jobsTrackerStatusSweepJob } from '@jobs/jobs/trackerStatusSweepJob'
import { paymentRecoveryJob } from '@payments/jobs/paymentRecoveryJob'
import { hireEmailOutboxJob } from '@hire/jobs/emailOutboxJob'
import { hireMediaRetentionJob } from '@hire/jobs/mediaRetentionJob'
import { hireEngineRevocationJob } from '@hire/jobs/engineRevocationJob'
import { hireLifecycleRetentionJob } from '@hire/jobs/lifecycleRetentionJob'
import { hireRuntimeFeedbackRecoveryJob } from '@modules/hire-runtime/jobs/feedbackRecoveryJob'
import { hireRuntimeResultPublisherJob } from '@modules/hire-runtime/jobs/resultPublisherJob'

/**
 * Inngest handler route — entry point for all background jobs.
 *
 * - Event-triggered: analysisJob ('analysis/requested')
 *                    pathwayJob   ('pathway/regenerate')
 * - Scheduled:       emailDigestJob, regeneratePlansJob, keepMongoWarmJob,
 *                    recordingRetentionJob
 *
 * Inngest's serve() handler responds to:
 *   GET   — health check + function introspection for Inngest Cloud sync
 *   POST  — receives event deliveries for event-triggered functions
 *   PUT   — function execution (step-by-step)
 *
 * maxDuration is raised from the default so that individual step executions
 * (especially the Whisper + fusion steps in analysisJob) have headroom. Inngest
 * splits between steps, so each step runs inside its own function invocation
 * — 300s is generous for our longest single step.
 */
export const maxDuration = 300
export const dynamic = 'force-dynamic'

const b2cFunctions = [analysisJob, enrichFeedbackJob, emailDigestJob, regeneratePlansJob, keepMongoWarmJob, recordingRetentionJob, pathwayJob, jobsIngestSchedulerJob, jobsSourceSyncJob, jobsSourceValidateJob, jobsBoardProbeJob, jobsRetentionSweepJob, jobsTrackerStatusSweepJob, jobsEvaluatePostingsJob, jobsVerdictSweeperJob, jobsAtsCheckJob, jobsEmailE0Job, jobsEmailSweepJob, jobsEvidenceAttributionJob, jobsEvidenceReconcileJob, jobsLinkCheckJob, paymentRecoveryJob]

const functions =
  process.env.IPG_SURFACE === 'hire-engine'
    ? [hireRuntimeFeedbackRecoveryJob, hireRuntimeResultPublisherJob]
    : process.env.IPG_SURFACE === 'hire-control'
      ? [
          hireEmailOutboxJob,
          hireMediaRetentionJob,
          hireEngineRevocationJob,
          hireLifecycleRetentionJob,
        ]
      : b2cFunctions

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions,
})
