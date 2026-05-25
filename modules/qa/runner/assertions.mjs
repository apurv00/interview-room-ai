/**
 * Deterministic activity assertions — shared by report generator and Playwright runner (v3.1).
 * Browser harness mirrors this logic inline in qa-matrix-runner.js until bundled.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const defaultConfig = JSON.parse(
  readFileSync(join(root, 'config/assertions.json'), 'utf-8'),
)

function assert(id, pass, message, severity = 'fail') {
  return { id, pass, message, severity }
}

function previewKeys(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return []
  return Object.keys(data).slice(0, 30)
}

/**
 * @param {import('./types.mjs').TelemetryBundle} bundle
 * @param {object} [config]
 */
export function evaluateActivity(bundle, config = defaultConfig) {
  const assertions = []
  const { step, stage, apiResult, network = [], console: consoleEntries = [] } = bundle
  const meta = bundle.meta ?? {}

  if (apiResult) {
    assertions.push(assert('http-ok', apiResult.ok || apiResult.status < 500, `HTTP ${apiResult.status}`, apiResult.status >= 500 ? 'fail' : 'warn'))
    assertions.push(assert('no-5xx', apiResult.status < 500, `Status ${apiResult.status} is 5xx`, 'fail'))
  }

  for (const n of network) {
    if (n.status != null && n.status >= 500) {
      assertions.push(assert('net-no-5xx', false, `${n.method} ${n.url} → ${n.status}`, 'fail'))
    }
    if (n.failed) {
      assertions.push(assert('net-not-failed', false, `${n.method} ${n.url} request failed`, 'fail'))
    }
  }

  for (const c of consoleEntries) {
    if (c.level !== 'error') continue
    const allowed = (config.consoleErrorAllowlist ?? []).some((prefix) => c.text.includes(prefix))
    if (!allowed) {
      assertions.push(assert('no-console-error', false, `Console error: ${c.text.slice(0, 120)}`, 'fail'))
    }
  }

  if (step === 'generate-question' && meta.question != null) {
    const min = config.questionMinLength ?? 20
    assertions.push(
      assert('q-nonempty', meta.question.length >= min, `Question length ${meta.question.length} < ${min}`, 'fail'),
    )
    const maxMs = config.latencyMs?.generateQuestion ?? 8000
    if (apiResult?.ms != null) {
      assertions.push(assert('q-latency', apiResult.ms < maxMs, `Generate-question ${apiResult.ms}ms > ${maxMs}ms`, 'warn'))
    }
  }

  if (step === 'evaluate-answer' && meta.eval) {
    for (const dim of ['relevance', 'structure', 'specificity', 'ownership']) {
      const v = Number(meta.eval[dim])
      assertions.push(assert(`ev-${dim}`, Number.isFinite(v), `Missing dimension ${dim}`, 'fail'))
    }
    const maxMs = config.latencyMs?.evaluateAnswer ?? 10000
    if (apiResult?.ms != null) {
      assertions.push(assert('ev-latency', apiResult.ms < maxMs, `Evaluate ${apiResult.ms}ms > ${maxMs}ms`, 'warn'))
    }
  }

  if (step === 'generate-feedback') {
    assertions.push(
      assert('fb-response', apiResult?.ok || apiResult?.status === 202, `Feedback HTTP ${apiResult?.status}`, 'fail'),
    )
    if (meta.overallScore != null) {
      assertions.push(assert('fb-score', meta.overallScore != null, 'overall_score present', 'fail'))
    }
    if (meta.pathwayPlanStatus != null) {
      assertions.push(
        assert(
          'fb-pathway-enqueued',
          meta.pathwayPlanStatus === 'scheduled',
          `pathwayPlan status=${meta.pathwayPlanStatus}`,
          'warn',
        ),
      )
    }
  }

  if (step === 'pathway-poll' && meta.pathwayGenerationStatus != null) {
    const terminal = ['succeeded', 'failed', 'skipped'].includes(meta.pathwayGenerationStatus)
    assertions.push(
      assert('pw-terminal', terminal, `pathwayGenerationStatus=${meta.pathwayGenerationStatus}`, terminal ? 'fail' : 'warn'),
    )
    if (meta.pollIndex === meta.pollMax - 1 && !terminal) {
      assertions.push(assert('pw-succeeded', false, 'Pathway poll exhausted without terminal status', 'fail'))
    }
  }

  if (step === 'pathway-get-plan' && meta.pathwayGenerationStatus === 'succeeded') {
    assertions.push(
      assert('pw-plan-items', (meta.planItems ?? 0) > 0, 'No plan items after succeeded', 'warn'),
    )
  }

  if (step === 'analysis-poll' && meta.analysisStatus != null) {
    if (meta.pollIndex === meta.pollMax - 1 && !['completed', 'failed'].includes(meta.analysisStatus)) {
      assertions.push(assert('an-complete', false, `Analysis poll timeout status=${meta.analysisStatus}`, 'fail'))
    }
    if (meta.analysisStatus === 'completed') {
      assertions.push(assert('an-timeline', (meta.timelineEvents ?? 0) > 0, 'Completed with empty timeline', 'warn'))
    }
  }

  if (step === 'analysis-start') {
    assertions.push(assert('an-start', apiResult?.ok || apiResult?.status === 403, `Analysis start ${apiResult?.status}`, 'fail'))
  }

  return assertions
}

export function verdictFromAssertions(assertions) {
  if (assertions.some((a) => !a.pass && a.severity === 'fail')) return 'fail'
  if (assertions.some((a) => !a.pass)) return 'warn'
  return 'pass'
}

export function summarizeTelemetry(telemetry) {
  const byStage = {}
  let pass = 0
  let warn = 0
  let fail = 0
  for (const t of telemetry) {
    byStage[t.stage] = byStage[t.stage] ?? { pass: 0, warn: 0, fail: 0, total: 0 }
    byStage[t.stage].total++
    byStage[t.stage][t.verdict]++
    if (t.verdict === 'pass') pass++
    else if (t.verdict === 'warn') warn++
    else fail++
  }
  return { total: telemetry.length, pass, warn, fail, byStage }
}

export function bodyPreview(text, max = 1000) {
  if (!text) return ''
  return text.length <= max ? text : text.slice(0, max) + '…'
}

export function responseKeys(data) {
  return previewKeys(data)
}
