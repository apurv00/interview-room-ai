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
      const session = await InterviewSession.findById(analysis.sessionId).lean()
      if (session) {
        // Delete R2 objects (best-effort — failures logged, not thrown)
        const keysToDelete = [
          session.recordingR2Key,
          session.audioRecordingR2Key,
          session.facialLandmarksR2Key,
          session.screenRecordingR2Key,
        ].filter(Boolean) as string[]

        for (const key of keysToDelete) {
          await deleteFromR2(key).catch((err) =>
            aiLogger.warn({ err, key, sessionId: analysis.sessionId }, 'Failed to delete R2 object during analysis cap cleanup')
          )
        }

        // Clear recording fields on session — keep session for transcript/feedback
        await InterviewSession.findByIdAndUpdate(analysis.sessionId, {
          $unset: {
            recordingR2Key: 1,
            audioRecordingR2Key: 1,
            facialLandmarksR2Key: 1,
            screenRecordingR2Key: 1,
            multimodalAnalysisId: 1,
          },
          hasRecording: false,
          hasScreenRecording: false,
        })
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
