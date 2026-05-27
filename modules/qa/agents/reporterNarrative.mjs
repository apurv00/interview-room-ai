/**
 * Optional executive narrative for QA reports (0–1 SDK call per run).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { runOutputDir } from '../orchestrator/runManifest.mjs'
import { promptJson } from './sdkClient.mjs'

/**
 * @param {string} reportId
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.log]
 */
export async function generateReporterNarrative(reportId, opts = {}) {
  const log = opts.log ?? console.log
  const outDir = runOutputDir(reportId)

  const triagePath = join(outDir, 'triage-summary.json')
  const sdkTriagePath = join(outDir, 'sdk-triage.json')
  const diffPath = join(outDir, 'baseline-diff.json')

  if (!existsSync(triagePath)) {
    throw new Error(`Missing ${triagePath} — run triage first`)
  }

  const triage = JSON.parse(readFileSync(triagePath, 'utf-8'))
  const sdkTriage = existsSync(sdkTriagePath) ? JSON.parse(readFileSync(sdkTriagePath, 'utf-8')) : null
  const baselineDiff = existsSync(diffPath) ? JSON.parse(readFileSync(diffPath, 'utf-8')) : null

  if (sdkTriage?.executiveSummary) {
    const narrative = {
      reportId,
      generatedAt: new Date().toISOString(),
      source: 'sdk-triage-cache',
      executiveSummary: sdkTriage.executiveSummary,
      shipRecommendation: sdkTriage.shipRecommendation ?? null,
      metrics: triage.metrics ?? null,
      activeP0Count: triage.activeP0Count ?? 0,
    }
    const outPath = join(outDir, 'narrative.md')
    writeFileSync(outPath, formatNarrativeMarkdown(narrative, baselineDiff), 'utf-8')
    return { narrative, outPath, backend: 'cached' }
  }

  const prompt = `Write a concise QA run executive summary for Interview Prep Guru stakeholders.

Report: ${reportId}
Pass rate: ${triage.metrics?.passRate ?? 'n/a'}
Pathway success: ${triage.metrics?.pathwayGenSucceeded ?? 'n/a'}/${triage.metrics?.totalRuns ?? 'n/a'}
Active P0: ${triage.activeP0Count ?? 0}
Baseline diff: ${baselineDiff ? JSON.stringify(baselineDiff).slice(0, 800) : 'none'}

Top findings:
${(triage.findings ?? [])
  .filter((f) => f.status !== 'resolved')
  .slice(0, 8)
  .map((f) => `- [${f.severity}] ${f.title}`)
  .join('\n')}

Respond JSON only:
{
  "executiveSummary": "3-5 sentences, plain language, mention ship/no-ship",
  "highlights": ["bullet", "..."],
  "shipRecommendation": "block | caution | ship"
}`

  log('Generating reporter narrative (1 SDK call)')
  const { data, backend, model } = await promptJson(prompt, { maxTokens: 1024 })

  const narrative = {
    reportId,
    generatedAt: new Date().toISOString(),
    source: 'sdk-reporter',
    backend,
    model,
    executiveSummary: data.executiveSummary ?? '',
    highlights: data.highlights ?? [],
    shipRecommendation: data.shipRecommendation ?? 'caution',
    metrics: triage.metrics ?? null,
    activeP0Count: triage.activeP0Count ?? 0,
  }

  const outPath = join(outDir, 'narrative.md')
  writeFileSync(outPath, formatNarrativeMarkdown(narrative, baselineDiff), 'utf-8')
  return { narrative, outPath, backend, model }
}

/**
 * @param {object} narrative
 * @param {object|null} baselineDiff
 */
function formatNarrativeMarkdown(narrative, baselineDiff) {
  const lines = [
    `# QA Executive Summary — ${narrative.reportId}`,
    '',
    `Generated: ${narrative.generatedAt}`,
    '',
    '## Summary',
    '',
    narrative.executiveSummary || '(no summary)',
    '',
  ]

  if (narrative.highlights?.length) {
    lines.push('## Highlights', '')
    for (const h of narrative.highlights) lines.push(`- ${h}`)
    lines.push('')
  }

  lines.push('## Ship recommendation', '', `**${narrative.shipRecommendation ?? 'caution'}**`, '')

  if (narrative.metrics) {
    lines.push(
      '## Metrics',
      '',
      `- Pass rate: ${narrative.metrics.passRate ?? 'n/a'}`,
      `- Active P0: ${narrative.activeP0Count ?? 0}`,
      `- Pathway succeeded: ${narrative.metrics.pathwayGenSucceeded ?? 'n/a'}/${narrative.metrics.totalRuns ?? 'n/a'}`,
      '',
    )
  }

  if (baselineDiff && !baselineDiff.error) {
    lines.push('## Baseline diff', '', `- Baseline: ${baselineDiff.baselineId ?? 'unknown'}`, '')
  }

  return lines.join('\n')
}
