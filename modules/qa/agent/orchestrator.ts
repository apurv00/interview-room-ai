import type {
  HarnessConfig,
  MatrixRun,
  SimulationRunResult,
  SimulationStage,
  StageResult,
} from './types'
import type { QaHttpClient } from '../client/httpClient'
import { matrixKey } from '../config/matrix'
import { runInterviewStage, collectUpgradeHints, stageResultFromInterview } from '../runners/interviewRunner'
import { runFeedbackStage } from '../runners/feedbackRunner'
import { runAnalysisStage } from '../runners/analysisRunner'
import { runPathwayStage } from '../runners/pathwayRunner'
import { runDrillStage } from '../runners/drillRunner'

export async function runSingleSimulation(
  client: QaHttpClient,
  harness: HarnessConfig,
  run: MatrixRun,
): Promise<SimulationRunResult> {
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  const stages: StageResult[] = []
  const upgradeRecommendations: string[] = []
  let sessionId: string | undefined
  let pass = true

  const shouldRun = (s: SimulationStage) => harness.stages.includes(s)

  try {
    if (shouldRun('interview')) {
      const ivStart = new Date().toISOString()
      const interview = await runInterviewStage(client, {
        domain: run.cell.domain,
        depth: run.cell.depth,
        persona: run.persona,
        harness,
      })
      sessionId = interview.sessionId
      const stage = stageResultFromInterview(ivStart, interview)
      stages.push(stage)
      pass &&= stage.pass
      upgradeRecommendations.push(...collectUpgradeHints(stage, 'interview'))
      for (const q of interview.questions) {
        upgradeRecommendations.push(...q.checks.filter((c) => !c.pass).map((c) => `[Q${q.questionIndex + 1}] ${c.label}`))
      }

      if (shouldRun('feedback')) {
        const fb = await runFeedbackStage(client, harness, interview)
        stages.push(fb)
        pass &&= fb.pass
        if (fb.notes) upgradeRecommendations.push(...fb.notes)

        if (sessionId && shouldRun('analysis')) {
          const an = await runAnalysisStage(client, harness, sessionId)
          stages.push(an)
          pass &&= an.pass
          if (an.notes) upgradeRecommendations.push(...an.notes)
        }

        if (sessionId && shouldRun('pathway')) {
          const pw = await runPathwayStage(client, harness, sessionId)
          stages.push(pw)
          pass &&= pw.pass
          if (pw.notes) upgradeRecommendations.push(...pw.notes)
        }

        if (sessionId && shouldRun('drill')) {
          const dr = await runDrillStage(client, harness, {
            sessionId,
            depth: run.cell.depth,
            persona: run.persona,
          })
          stages.push(dr)
          pass &&= dr.pass
          if (dr.notes) upgradeRecommendations.push(...dr.notes)
        }
      }
    }
  } catch (err) {
    pass = false
    upgradeRecommendations.push(`Fatal: ${err instanceof Error ? err.message : String(err)}`)
  }

  const finishedAt = new Date().toISOString()
  return {
    runId: run.runId,
    matrixKey: matrixKey(run.cell.domain, run.cell.depth, run.persona),
    domain: run.cell.domain,
    depth: run.cell.depth,
    persona: run.persona,
    sessionId,
    pass,
    startedAt,
    finishedAt,
    durationMs: Date.now() - t0,
    stages,
    allRoutes: [...client.routeLog],
    upgradeRecommendations: [...new Set(upgradeRecommendations)],
  }
}

export async function runMatrixWithConcurrency(
  harness: HarnessConfig,
  runs: MatrixRun[],
  onProgress?: (done: number, total: number, last: SimulationRunResult) => void,
): Promise<SimulationRunResult[]> {
  const results: SimulationRunResult[] = []
  let idx = 0

  async function worker(): Promise<void> {
    while (idx < runs.length) {
      const i = idx++
      const run = runs[i]
      const client = new (await import('../client/httpClient')).QaHttpClient({
        baseUrl: harness.baseUrl,
        sessionCookie: harness.sessionCookie,
      })
      const result = await runSingleSimulation(client, harness, run)
      results[i] = result
      onProgress?.(results.filter(Boolean).length, runs.length, result)
    }
  }

  const workers = Array.from({ length: Math.min(harness.concurrency, runs.length) }, () => worker())
  await Promise.all(workers)
  return results
}
