import { inngest } from '@shared/services/inngest'
import { aiLogger } from '@shared/logger'
import { cleanupExpiredReplayRecordings } from '@shared/services/recordingRetention'

export const recordingRetentionJob = inngest.createFunction(
  {
    id: 'recording-retention-cleanup',
    name: 'Clean up old replay recordings',
    triggers: [{ cron: '0 3 * * *' }],
  },
  async ({ step }) => {
    const result = await step.run('cleanup-expired-replay-recordings', () =>
      cleanupExpiredReplayRecordings()
    )
    aiLogger.info(result, 'Scheduled replay recording cleanup finished')
    return result
  }
)
