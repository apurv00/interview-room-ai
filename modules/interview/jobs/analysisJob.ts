import { inngest } from '@shared/services/inngest'
import { aiLogger } from '@shared/logger'
import { enforceAnalysisCap } from '@shared/services/analysisCleanup'
import {
  stepFetchSession,
  stepTranscribeAndDownload,
  stepProcessSignals,
  stepRunFusion,
  stepPersistResults,
  stepMarkFailed,
  shouldRunDualPipeline,
} from '../services/analysis/multimodalPipeline'

/**
 * Multimodal analysis background job.
 *
 * Triggered by `/api/analysis/start` via `inngest.send({ name: 'analysis/requested', ... })`.
 * Each step is independently retried by Inngest (default 3 attempts). If the
 * final attempt fails, `onFailure` marks the DB row as failed so the polling
 * client can surface the error.
 *
 * The steps mirror `runMultimodalPipeline` in `multimodalPipeline.ts` — we
 * reuse the existing pure-function stages verbatim. The only orchestration
 * logic here is the dual-pipeline gating (enhanced + baseline runs for
 * research consent) which preserves existing behavior.
 */

/**
 * Minimal shape of the Inngest `step` object we use. Declared locally so the
 * pure-function handler can be unit-tested with a hand-rolled mock that
 * doesn't need to know about the full Inngest runtime.
 */
interface AnalysisStepRunner {
  run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T>
}

export interface AnalysisJobEventData {
  sessionId: string
  userId: string
  startTime: number
}

/**
 * Pure handler — exported separately from the Inngest wrapper so tests can
 * invoke it directly with a mocked step object.
 */
export async function runAnalysisJobHandler(
  event: { data: AnalysisJobEventData },
  step: AnalysisStepRunner
): Promise<{ sessionId: string; status: 'completed' }> {
  const { sessionId, userId, startTime } = event.data

  // Step 1: fetch session + flip status to 'processing'
  const session = await step.run('fetch-session', () => stepFetchSession(sessionId))

  // Step 2: transcribe + download facial frames in parallel
  const { whisper, facialFrames } = await step.run('transcribe-and-download', () =>
    stepTranscribeAndDownload(
      session.recordingR2Key,
      session.facialLandmarksR2Key,
      session.audioRecordingR2Key,
      session.liveTranscriptWords,
      session.transcript,
      session.sessionT0,
    )
  )

  // Step 3: prosody + facial aggregation (pure CPU work — still wrapped in a
  // step so Inngest replay sees it as a checkpoint and so it's retryable
  // independently if any downstream step throws)
  const signals = await step.run('process-signals', () =>
    stepProcessSignals(
      whisper.segments,
      facialFrames,
      session.questionBoundaries,
      whisper.durationSeconds
    )
  )

  // Pre-normalise transcript timestamps for fusion so the meta-block reports
  // sensible seconds-since-t0 instead of raw ms-epoch values. Pure transform,
  // no step.run wrapper needed.
  const normalisedTranscript = session.transcript.map((t) => ({
    ...t,
    timestamp: Math.max(0, (t.timestamp - session.sessionT0) / 1000),
  }))

  // Step 4a: enhanced fusion run (the one users see)
  const enhanced = await step.run('run-fusion-enhanced', () =>
    stepRunFusion(
      signals.prosodySegments,
      signals.facialSegments,
      session.evaluations,
      normalisedTranscript as unknown as Array<Record<string, unknown>>,
      session.config,
      { includeBlendshapes: true }
    )
  )

  // Step 4b: baseline fusion run — only if research consent + flag + stats
  const dualRun = await step.run('should-run-dual', () =>
    shouldRunDualPipeline(userId, signals.facialSegments)
  )

  let baseline: Awaited<ReturnType<typeof stepRunFusion>> | null = null
  if (dualRun) {
    baseline = await step.run('run-fusion-baseline', () =>
      stepRunFusion(
        signals.prosodySegments,
        signals.facialSegments,
        session.evaluations,
        normalisedTranscript as unknown as Array<Record<string, unknown>>,
        session.config,
        { includeBlendshapes: false }
      )
    )
    aiLogger.info(
      {
        sessionId,
        enhancedPromptBytes: enhanced.promptLength,
        baselinePromptBytes: baseline.promptLength,
        promptByteDelta: enhanced.promptLength - baseline.promptLength,
        enhancedBodyLanguage: enhanced.fusionSummary.overallBodyLanguageScore,
        baselineBodyLanguage: baseline.fusionSummary.overallBodyLanguageScore,
        enhancedEyeContact: enhanced.fusionSummary.eyeContactScore,
        baselineEyeContact: baseline.fusionSummary.eyeContactScore,
      },
      'Dual-pipeline comparison run completed'
    )
  }

  // Step 5: persist results + track usage
  await step.run('persist-results', () =>
    stepPersistResults(sessionId, userId, {
      whisperSegments: whisper.segments,
      prosodySegments: signals.prosodySegments,
      facialSegments: signals.facialSegments,
      facialTimeseries: signals.facialTimeseries,
      timeline: enhanced.timeline as unknown as Array<Record<string, unknown>>,
      fusionSummary: enhanced.fusionSummary as unknown as Record<string, unknown>,
      baselineTimeline: baseline
        ? (baseline.timeline as unknown as Array<Record<string, unknown>>)
        : undefined,
      baselineFusionSummary: baseline
        ? (baseline.fusionSummary as unknown as Record<string, unknown>)
        : undefined,
      facialLandmarksR2Key: session.facialLandmarksR2Key,
      whisperCostUsd: whisper.costUsd,
      fusionInputTokens: enhanced.inputTokens + (baseline?.inputTokens || 0),
      fusionOutputTokens: enhanced.outputTokens + (baseline?.outputTokens || 0),
      fusionModel: enhanced.model,
      startTime,
    })
  )

  // Step 6: enforce per-user analysis cap — delete oldest analyses (and their
  // R2 recordings) beyond the 10-analysis rolling limit. The inline fallback
  // path in /api/analysis/start already calls this, but the Inngest path was
  // missing it — meaning background-job analyses were never capped.
  //
  // Defensive: cap enforcement is best-effort cleanup. If it throws (e.g. DB
  // connection blip), DO NOT let Inngest retry → onFailure overwrite the
  // already-completed analysis row's status with 'failed'. Log the error and
  // return — the analysis is persisted and the user should see 'completed'.
  await step.run('enforce-analysis-cap', async () => {
    try {
      return await enforceAnalysisCap(userId)
    } catch (err) {
      aiLogger.warn(
        { err, userId, sessionId },
        'Cap enforcement failed — analysis already persisted, continuing without cleanup'
      )
      return { deleted: 0 }
    }
  })

  return { sessionId, status: 'completed' }
}

export const analysisJob = inngest.createFunction(
  {
    id: 'multimodal-analysis',
    name: 'Run multimodal analysis pipeline',
    retries: 2, // total attempts: 3
    triggers: [{ event: 'analysis/requested' }],
    onFailure: async ({ event, error }) => {
      // `event` here is the internal failure event; the original trigger
      // event lives at event.data.event.
      const originalEvent = (event.data as { event?: { data?: AnalysisJobEventData } }).event
      const sessionId = originalEvent?.data?.sessionId
      const startTime = originalEvent?.data?.startTime ?? Date.now()
      if (!sessionId) {
        aiLogger.error({ err: error }, 'analysisJob onFailure: missing sessionId in event payload')
        return
      }
      aiLogger.error(
        { err: error, sessionId },
        'analysisJob failed after retries — marking analysis row failed'
      )
      await stepMarkFailed(sessionId, error.message || 'Analysis failed', startTime)
    },
  },
  async ({ event, step }) => runAnalysisJobHandler(
    event as unknown as { data: AnalysisJobEventData },
    step as unknown as AnalysisStepRunner
  )
)
