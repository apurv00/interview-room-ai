import Anthropic from '@anthropic-ai/sdk'
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runOutputDir } from '../orchestrator/runManifest.mjs'
import { classifyActivity } from './observer.mjs'

const DEFAULT_MODEL = 'claude-3-5-haiku-latest'
const DEFAULT_MAX_CALLS = 50
const DEFAULT_CONCURRENCY = 3

/**
 * Activities worth an LLM pass: failures, warns, inconclusive rule output, audit samples.
 * @param {object} bundle
 * @param {object} ruleObs
 */
export function shouldUseLlm(bundle, ruleObs) {
  if (bundle.verdict === 'fail' || bundle.verdict === 'warn') return true
  if (ruleObs.classification === 'inconclusive') return true
  if (ruleObs.classification === 'audit-pass') return true
  return false
}

/**
 * @param {object} bundle
 * @param {object} ruleObs
 */
function buildPrompt(bundle, ruleObs) {
  const failed = (bundle.assertions ?? []).filter((a) => !a.pass)
  const consoleLines = (bundle.console ?? []).slice(-8).map((c) => `[${c.level}] ${c.text}`)
  const networkLines = (bundle.network ?? []).slice(-5).map(
    (n) => `${n.method} ${n.url} → ${n.status ?? 'failed'} (${n.durationMs}ms)`,
  )

  return `You are a QA triage agent for Interview Prep Guru. Classify this failed/warn QA activity.

Activity: ${bundle.activityId}
Stage/step: ${bundle.stage}/${bundle.step}
Verdict: ${bundle.verdict}
Rule-based classification: ${ruleObs.classification} (${ruleObs.severity})

Failed assertions:
${failed.map((a) => `- ${a.id}: ${a.message}`).join('\n') || '(none)'}

Recent console:
${consoleLines.join('\n') || '(none)'}

Recent network:
${networkLines.join('\n') || '(none)'}

Respond with JSON only:
{
  "classification": "product-bug | harness-artifact | infra | flaky | inconclusive",
  "severity": "P0 | P1 | P2 | none",
  "summary": "one sentence",
  "evidence": ["bullet", "..."],
  "suggestedNextSteps": ["action", "..."]
}`
}

/**
 * @param {string} text
 */
function parseLlmJson(text) {
  const trimmed = text.trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('No JSON object in LLM response')
  return JSON.parse(trimmed.slice(start, end + 1))
}

/**
 * @param {object} opts
 * @param {string} opts.reportId
 * @param {number} [opts.maxCalls]
 * @param {number} [opts.concurrency]
 * @param {string} [opts.model]
 * @param {(msg: string) => void} [opts.log]
 */
export async function llmObserveRun(opts) {
  const { reportId, log = console.log } = opts
  const maxCalls = opts.maxCalls ?? DEFAULT_MAX_CALLS
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY
  const model = opts.model ?? process.env.QA_LLM_OBSERVER_MODEL ?? DEFAULT_MODEL

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set — cannot run LLM observer')
  }

  const activitiesDir = join(runOutputDir(reportId), 'activities')
  if (!existsSync(activitiesDir)) {
    throw new Error(`No activities/ dir for ${reportId}`)
  }

  const files = readdirSync(activitiesDir).filter((f) => f.endsWith('.json'))
  /** @type {{ file: string, bundle: object, ruleObs: object }[]} */
  const candidates = []

  for (const file of files) {
    const bundle = JSON.parse(readFileSync(join(activitiesDir, file), 'utf-8'))
    const ruleObs = classifyActivity(bundle)
    if (shouldUseLlm(bundle, ruleObs)) {
      candidates.push({ file, bundle, ruleObs })
    }
  }

  const toProcess = candidates.slice(0, maxCalls)
  log(`LLM observer: ${toProcess.length}/${candidates.length} candidates (cap ${maxCalls})`)

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const outDir = join(runOutputDir(reportId), 'observations')
  mkdirSync(outDir, { recursive: true })

  /** @type {object[]} */
  const observations = []
  let calls = 0
  let index = 0

  async function worker() {
    while (index < toProcess.length) {
      const i = index++
      const { bundle, ruleObs } = toProcess[i]
      const prompt = buildPrompt(bundle, ruleObs)

      try {
        const res = await client.messages.create({
          model,
          max_tokens: 512,
          messages: [{ role: 'user', content: prompt }],
        })
        calls++
        const text = res.content.find((b) => b.type === 'text')?.text ?? ''
        const parsed = parseLlmJson(text)
        const obs = {
          activityId: bundle.activityId,
          classification: parsed.classification ?? ruleObs.classification,
          severity: parsed.severity ?? ruleObs.severity,
          summary: parsed.summary ?? ruleObs.summary,
          evidence: parsed.evidence ?? ruleObs.evidence,
          suggestedNextSteps: parsed.suggestedNextSteps ?? ruleObs.suggestedNextSteps,
          runId: reportId,
          matrixKey: bundle.matrixKey,
          stage: bundle.stage,
          step: bundle.step,
          verdict: bundle.verdict,
          agentId: `llm-observer:${model}`,
          ruleClassification: ruleObs.classification,
          observedAt: new Date().toISOString(),
        }
        observations.push(obs)
        const safe = obs.activityId.replace(/[/\\:]/g, '__')
        writeFileSync(join(outDir, safe + '.json'), JSON.stringify(obs, null, 2), 'utf-8')
        log(`  LLM ${obs.activityId} → ${obs.classification}`)
      } catch (err) {
        log(`  LLM failed ${bundle.activityId}: ${err instanceof Error ? err.message : String(err)}`)
        const fallback = {
          ...ruleObs,
          runId: reportId,
          matrixKey: bundle.matrixKey,
          stage: bundle.stage,
          step: bundle.step,
          verdict: bundle.verdict,
          agentId: 'llm-observer-fallback',
          observedAt: new Date().toISOString(),
        }
        observations.push(fallback)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, toProcess.length || 1) }, () => worker()))

  const summary = {
    reportId,
    observedAt: new Date().toISOString(),
    agent: 'llm-observer',
    model,
    llmCalls: calls,
    candidateCount: candidates.length,
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

  return { observations, summary, outDir, llmCalls: calls }
}
