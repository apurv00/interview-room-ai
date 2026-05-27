/**
 * Phase 4 — one structured LLM call per run to dedupe patterns and refine recommendations.
 * Uses sdkClient (Cursor SDK or Anthropic fallback).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { runOutputDir } from '../orchestrator/runManifest.mjs'
import { promptJson } from './sdkClient.mjs'

/**
 * @param {string} reportId
 * @param {object} deterministicSummary — output of triageRun().summary
 * @param {(msg: string) => void} [log]
 */
export async function sdkTriageRun(reportId, deterministicSummary, log = console.log) {
  const outDir = runOutputDir(reportId)
  const findings = deterministicSummary.findings ?? []
  const activeFindings = findings.filter((f) => f.severity !== 'P2' && f.status !== 'resolved' && f.status !== 'wont-fix')

  const obsDir = join(outDir, 'observations')
  /** @type {object[]} */
  let obsSample = []
  if (existsSync(obsDir)) {
    const { readdirSync } = await import('node:fs')
    obsSample = readdirSync(obsDir)
      .filter((f) => f.endsWith('.json') && f !== 'summary.json')
      .slice(0, 20)
      .map((f) => {
        const o = JSON.parse(readFileSync(join(obsDir, f), 'utf-8'))
        return {
          activityId: o.activityId,
          classification: o.classification,
          severity: o.severity,
          summary: o.summary,
        }
      })
  }

  const prompt = `You are the QA Triage agent for Interview Prep Guru (mock interview SaaS).

Merge deterministic findings into deduped patterns. Deterministic assertions win on conflict with LLM observer guesses.

Report ID: ${reportId}
Metrics: ${JSON.stringify(deterministicSummary.metrics ?? {}, null, 0).slice(0, 2000)}
Active findings (${activeFindings.length}):
${activeFindings.slice(0, 40).map((f) => `- [${f.severity}] ${f.id}: ${f.title} (${f.classification ?? f.status})`).join('\n') || '(none)'}

Observer sample (${obsSample.length}):
${obsSample.map((o) => `- ${o.activityId}: ${o.classification} — ${o.summary}`).join('\n') || '(none)'}

Respond with JSON only:
{
  "executiveSummary": "2-4 sentences for stakeholders",
  "patterns": [
    {
      "id": "PATTERN-001",
      "severity": "P0 | P1 | P2",
      "title": "short title",
      "findingIds": ["AUTO-..."],
      "classification": "product-bug | harness-artifact | infra | flaky | inconclusive",
      "impact": "one sentence",
      "evidence": ["bullet"],
      "recommendedAction": "file-ticket | re-run-cell | ignore-harness | monitor"
    }
  ],
  "recommendations": [
    { "action": "block-release | ship-ok | run-full-matrix | investigate", "reason": "..." }
  ],
  "shipRecommendation": "block | caution | ship"
}`

  log(`SDK triage: ${activeFindings.length} active findings, ${obsSample.length} observer samples`)
  const { data, backend, model } = await promptJson(prompt, { maxTokens: 4096 })

  const sdkTriage = {
    reportId,
    triagedAt: new Date().toISOString(),
    agent: 'sdk-triage',
    backend,
    model,
    executiveSummary: data.executiveSummary ?? '',
    patterns: data.patterns ?? [],
    recommendations: data.recommendations ?? [],
    shipRecommendation: data.shipRecommendation ?? 'caution',
    inputFindingCount: findings.length,
    activeFindingCount: activeFindings.length,
  }

  const outPath = join(outDir, 'sdk-triage.json')
  writeFileSync(outPath, JSON.stringify(sdkTriage, null, 2), 'utf-8')

  return { sdkTriage, outPath, backend, model }
}

/**
 * Merge SDK triage into deterministic summary (non-destructive).
 * @param {object} summary
 * @param {object} sdkTriage
 */
export function mergeSdkTriage(summary, sdkTriage) {
  return {
    ...summary,
    sdkTriage: {
      executiveSummary: sdkTriage.executiveSummary,
      patterns: sdkTriage.patterns,
      recommendations: sdkTriage.recommendations,
      shipRecommendation: sdkTriage.shipRecommendation,
      backend: sdkTriage.backend,
      model: sdkTriage.model,
    },
    recommendations: [
      ...(summary.recommendations ?? []),
      ...(sdkTriage.recommendations ?? []).filter(
        (r) => !(summary.recommendations ?? []).some((x) => x.action === r.action),
      ),
    ],
  }
}
