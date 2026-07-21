import { connectDB } from '@shared/db/connection'
import { MultimodalAnalysis } from '@shared/db/models/MultimodalAnalysis'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import { deleteFromR2 } from '@shared/storage/r2'
import { aiLogger } from '@shared/logger'

const MAX_ACTIVE_ANALYSES = 10

/**
 * Enforce the per-user analysis cap. After a new analysis completes,
 * delete the oldest analyses (and their R2 recordings) that exceed the cap.
 *
 * The interview session itself is preserved (transcript, evaluations, feedback).
 * Only the recording files and multimodal analysis document are removed.
 */
export async function enforceAnalysisCap(
  userId: string,
  maxCount: number = MAX_ACTIVE_ANALYSES,
): Promise<{ deleted: number }> {
  await connectDB()

  const analyses = await MultimodalAnalysis.find({ userId, status: 'completed' })
    .sort({ createdAt: -1 }) // newest first
    .lean()

  if (analyses.length <= maxCount) return { deleted: 0 }

  const toDelete = analyses.slice(maxCount)
  let deleted = 0

  for (const analysis of toDelete) {
    try {
      // Find the linked session to clean up R2 recordings
      const session = await InterviewSession.findOne({
        _id: analysis.sessionId,
        userId,
      }).lean()
      if (session) {
        const artifacts: Array<{
          field: string
          key?: string
          unset: Record<string, 1>
        }> = [
          {
            field: 'recordingR2Key',
            key: session.recordingR2Key,
            unset: { recordingR2Key: 1, recordingDurationSeconds: 1 },
          },
          {
            field: 'audioRecordingR2Key',
            key: session.audioRecordingR2Key,
            unset: { audioRecordingR2Key: 1 },
          },
          {
            field: 'facialLandmarksR2Key',
            key: session.facialLandmarksR2Key,
            unset: { facialLandmarksR2Key: 1 },
          },
          {
            field: 'screenRecordingR2Key',
            key: session.screenRecordingR2Key,
            unset: { screenRecordingR2Key: 1 },
          },
        ]
        const persistedArtifacts = artifacts.filter((artifact): artifact is {
          field: string
          key: string
          unset: Record<string, 1>
        } => typeof artifact.key === 'string' && artifact.key.length > 0)

        let artifactCleanupFailed = false
        for (const artifact of persistedArtifacts) {
          try {
            await deleteFromR2(artifact.key, {
              ownerUserId: userId,
              sessionId: String(analysis.sessionId),
            })
            // Do not clear a newer recording that replaced this exact key
            // while the external delete was in flight.
            await InterviewSession.updateOne(
              {
                _id: analysis.sessionId,
                userId,
                [artifact.field]: artifact.key,
              },
              { $unset: artifact.unset },
            )
          } catch (err) {
            artifactCleanupFailed = true
            aiLogger.warn(
              { err, key: artifact.key, sessionId: analysis.sessionId },
              'Failed to delete R2 object during analysis cap cleanup',
            )
          }
        }
        if (artifactCleanupFailed) {
          // Keep the analysis row as durable retry inventory. A later cap run
          // retries failed objects instead of falsely reporting them deleted.
          continue
        }

        await InterviewSession.updateOne(
          {
            _id: analysis.sessionId,
            userId,
            multimodalAnalysisId: analysis._id,
          },
          { $unset: { multimodalAnalysisId: 1 } },
        )
      }

      // Delete the analysis document
      await MultimodalAnalysis.findByIdAndDelete(analysis._id)
      deleted++

      aiLogger.info(
        { sessionId: analysis.sessionId, analysisId: analysis._id, userId },
        'Deleted oldest analysis + recordings (cap enforcement)'
      )
    } catch (err) {
      aiLogger.error(
        { err, analysisId: analysis._id, userId },
        'Failed to delete analysis during cap enforcement — skipping'
      )
    }
  }

  return { deleted }
}
