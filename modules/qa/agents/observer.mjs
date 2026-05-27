import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { runOutputDir } from '../orchestrator/runManifest.mjs'

/**
 * Rule-based activity classifier (Phase 3.2 baseline — no LLM).
 * Upgrade path: optional Composer SDK pass when classification is inconclusive.
 *
 * @param {object} bundle TelemetryBundle
 */
export function classifyActivity(bundle) {
  const failed = (bundle.assertions ?? []).filter((a) => !a.pass)
  const failIds = failed.map((a) => a.id)
  const status = bundle.apiResult?.status ?? bundle.network?.[0]?.status ?? null
  const stage = bundle.stage
  const step = bundle.step

  if (bundle.verdict === 'pass') {
    return {
      activityId: bundle.activityId,
      classification: 'none',
      severity: 'none',
      summary: 'Activity passed deterministic assertions',
      evidence: [],
      suggestedNextSteps: [],
    }
  }

  const evidence = failed.map((a) => a.message).slice(0, 5)
  if (failIds.some((id) => id.startsWith('net-')) && status != null && status >= 500) {
    return {
      activityId: bundle.activityId,
      classification: 'infra',
      severity: 'P0',
      summary: `HTTP ${status} on ${stage}/${step}`,
      evidence,
      suggestedNextSteps: ['Check Vercel function logs', 'Verify Redis/Mongo connectivity'],
    }
  }

  if (stage === 'pathway' && failIds.includes('pw-succeeded')) {
    return {
      activityId: bundle.activityId,
      classification: 'product-bug',
      severity: 'P0',
      summary: 'Pathway generation did not reach succeeded/skipped within poll window',
      evidence,
      suggestedNextSteps: [
        'Check Inngest pathway-regenerate function',
        'Mongo: InterviewSession.pathwayGenerationStatus for session',
        'See modules/qa/docs/PATHWAY_P0_TRACE.md',
      ],
    }
  }

  if (stage === 'interview' && failIds.some((id) => id.startsWith('ev-') || id.includes('persona'))) {
    const harnessLikely = failIds.some((id) => id.includes('persona') || id.includes('band'))
    return {
      activityId: bundle.activityId,
      classification: harnessLikely ? 'harness-artifact' : 'product-bug',
      severity: harnessLikely ? 'P2' : 'P1',
      summary: harnessLikely
        ? 'Eval/persona band failure — likely canned answer mismatch'
        : `Interview eval failure on ${step}`,
      evidence,
      suggestedNextSteps: harnessLikely
        ? ['Review strongAnswers.json bucket route', 'Compare with human-rated answer']
        : ['Review evaluate-answer prompt calibration'],
    }
  }

  if (stage === 'feedback' && failIds.includes('fb-response')) {
    return {
      activityId: bundle.activityId,
      classification: 'product-bug',
      severity: 'P0',
      summary: 'Feedback generation failed',
      evidence,
      suggestedNextSteps: ['Check /api/generate-feedback logs', 'Verify Redis idempotency lock'],
    }
  }

  return {
    activityId: bundle.activityId,
    classification: 'inconclusive',
    severity: 'P1',
    summary: `Failed ${stage}/${step} — needs manual review`,
    evidence,
    suggestedNextSteps: ['Inspect activity JSON in runs/<id>/activities/'],
  }
}

/**
 * @param {string} reportId
 * @param {object} [opts]
 * @param {number} [opts.sampleRate] - fraction of pass activities to audit (default 0.05)
 */
export function observeRun(reportId, opts = {}) {
  const sampleRate = opts.sampleRate ?? 0.05
  const activitiesDir = join(runOutputDir(reportId), 'activities')
  if (!existsSync(activitiesDir)) {
    throw new Error(`No activities/ dir for ${reportId}`)
  }

  const files = readdirSync(activitiesDir).filter((f) => f.endsWith('.json'))
  const observations = []
  const rng = () => Math.random()

  for (const file of files) {
    const bundle = JSON.parse(readFileSync(join(activitiesDir, file), 'utf-8'))
    const shouldObserve =
      bundle.verdict === 'fail' || bundle.verdict === 'warn' || (bundle.verdict === 'pass' && rng() < sampleRate)
    if (!shouldObserve) continue

    const obs = {
      ...classifyActivity(bundle),
      runId: reportId,
      matrixKey: bundle.matrixKey,
      stage: bundle.stage,
      step: bundle.step,
      verdict: bundle.verdict,
      agentId: 'rule-based-observer-v1',
      observedAt: new Date().toISOString(),
    }
    if (obs.classification === 'none' && bundle.verdict === 'pass') {
      obs.classification = 'audit-pass'
      obs.severity = 'none'
      obs.summary = 'Random audit sample — passed'
    }
    observations.push(obs)
  }

  const outDir = join(runOutputDir(reportId), 'observations')
  mkdirSync(outDir, { recursive: true })
  for (const obs of observations) {
    const safe = obs.activityId.replace(/[/\\:]/g, '__')
    writeFileSync(join(outDir, safe + '.json'), JSON.stringify(obs, null, 2), 'utf-8')
  }

  const summary = {
    reportId,
    observedAt: new Date().toISOString(),
    totalActivities: files.length,
    observedCount: observations.length,
    byClassification: {},
    bySeverity: {},
  }
  for (const o of observations) {
    summary.byClassification[o.classification] = (summary.byClassification[o.classification] ?? 0) + 1
    if (o.severity !== 'none') {
      summary.bySeverity[o.severity] = (summary.bySeverity[o.severity] ?? 0) + 1
    }
  }
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf-8')

  return { observations, summary, outDir }
}
