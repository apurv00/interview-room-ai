#!/usr/bin/env node
/**
 * Generate Markdown + CSV from browser QA matrix JSON with quality-criteria mapping.
 * Usage: node scripts/generate-qa-browser-report.mjs [path-to-json]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { summarizeTelemetry, telemetryCsvRows, writeTelemetryArtifacts } from '../modules/qa/runner/telemetry.mjs'
import { formatDiffMarkdown } from '../modules/qa/agents/baselineDiff.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const inputPath =
  process.argv[2] ?? join(root, 'modules/qa/output/qa-browser-full-1779529900005.json')

const findingsConfigPath = join(root, 'modules/qa/config/reportFindings.json')
let manualFindings = []
try {
  manualFindings = JSON.parse(readFileSync(findingsConfigPath, 'utf-8')).findings ?? []
} catch {
  manualFindings = []
}

const raw = JSON.parse(readFileSync(inputPath, 'utf-8'))
const inputDir = dirname(inputPath)
const triagePath = join(inputDir, 'triage-summary.json')
const baselineDiffPath = join(inputDir, 'baseline-diff.json')
let triageSummary = null
let baselineDiffDoc = null
if (existsSync(triagePath)) {
  triageSummary = JSON.parse(readFileSync(triagePath, 'utf-8'))
}
if (existsSync(baselineDiffPath)) {
  baselineDiffDoc = JSON.parse(readFileSync(baselineDiffPath, 'utf-8'))
}
const telemetry = raw.telemetry ?? []
const telemetrySummary = raw.telemetrySummary ?? (telemetry.length ? summarizeTelemetry(telemetry) : null)

function avgDim(ev) {
  if (!ev) return null
  const dims = ['relevance', 'structure', 'specificity', 'ownership']
  const v = dims.map((d) => Number(ev[d])).filter((n) => Number.isFinite(n))
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null
}

function questionHeuristics(question, domain, depth) {
  const issues = []
  if (question.length < 20) issues.push('Question unusually short')
  if (/\bPm\b/.test(question)) issues.push('Domain label leaked')
  if (depth === 'coding' && !/(code|implement|algorithm|function|complexity|test)/i.test(question)) {
    issues.push('Coding depth missing implementation cues')
  }
  if (depth === 'system-design' && !/(design|scale|architect|trade|component|system)/i.test(question)) {
    issues.push('System-design missing architecture cues')
  }
  if (depth === 'case-study' && !/(estimate|framework|approach|scenario|calculate)/i.test(question)) {
    issues.push('Case-study missing structured reasoning cues')
  }
  return issues
}

function mapQualityCriteria(row) {
  const issues = []
  const ev = row.eval
  const avg = row.avg ?? avgDim(ev)
  const parts = row.run.split('/')
  const depth = parts[1]
  const persona = row.persona

  for (const h of questionHeuristics(row.question, parts[0], depth)) {
    issues.push(`[Q-gen] ${h}`)
  }

  if (!ev) {
    issues.push('[Eval] Missing evaluation payload')
    return issues
  }
  if (ev.status === 'failed') issues.push('[Eval] LLM eval returned failed status')

  const rel = Number(ev.relevance)
  const str = Number(ev.structure)

  if (persona === 'strong' && rel < 40) {
    issues.push('[Eval/Tech] Low relevance — answer did not address question topic')
    issues.push('[User] Perceived as "interviewer ignored my question" if follow-up missing')
  }
  if (str < 30) issues.push('[Eval/Tech] Low STAR/structure score')
  if (persona === 'strong' && avg != null && avg < 60) {
    issues.push(`[Harness/G3] Strong relevance calibration (avg ${avg}, target ≥60 — non-blocking on v2.4+)`)
  }
  if (persona === 'weak' && avg != null && avg <= 55) {
    issues.push(`[Harness] Weak persona in band (avg ${avg}) — separation OK`)
  }
  if (persona === 'weak' && avg != null && avg > 55) {
    issues.push('[Eval/Tech] Weak persona scored too high — eval may be too lenient')
  }

  const probe = ev.probeDecision
  if (probe?.shouldProbe) {
    issues.push(
      `[UX/Probe] LLM recommends ${probe.probeType} on "${probe.probeTarget}"${probe.isPivot ? ' (pivot)' : ''}`,
    )
  }

  if (row.genMs > 6000) issues.push(`[Perf] Slow question gen (${row.genMs}ms)`)
  if (row.evalMs > 8000) issues.push(`[Perf] Slow eval (${row.evalMs}ms)`)

  if (row.answer.startsWith('Regarding "') && row.answer.includes('At Acme')) {
    issues.push('[Harness artifact] Canned answer pasted with question hook — not adaptive')
  }

  return [...new Set(issues)]
}

function evNum(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function p50(arr) {
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.floor(s.length * 0.5)] ?? 0
}

function p95(arr) {
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.floor(s.length * 0.95)] ?? s.at(-1) ?? 0
}

function parseMatrixKey(matrixKey) {
  const parts = matrixKey.split('/')
  return {
    domain: parts[0] ?? '',
    depth: parts[1] ?? '',
    persona: parts[2] ?? '',
  }
}

function analysisStatus(run) {
  const stage = run.stages?.analysis
  if (!stage) return 'missing'
  if (stage.skipped) return stage.reason === '403' ? 'skipped-403' : 'skipped'
  if (stage.timeout) return 'timeout'
  return stage.data?.status ?? (stage.ok ? 'unknown' : 'error')
}

function pathwayState(run) {
  return run.stages?.pathway?.data?.state ?? 'missing'
}

function pathwayGenerationStatus(run) {
  return (
    run.stages?.pathway?.pathwayGenerationStatus ??
    run.stages?.pathway?.data?.pathwayGenerationStatus ??
    null
  )
}

function pathwayPlanEnqueueStatus(run) {
  return run.stages?.feedback?.pathwayPlanOutcome?.status ?? null
}

function drillStatus(run) {
  const drill = run.stages?.drill
  if (!drill) return 'missing'
  if (drill.skipped) return 'skipped'
  return drill.sseEvents != null ? 'completed' : 'unknown'
}

function fusionText(data) {
  if (!data?.fusionSummary) return ''
  const f = data.fusionSummary
  if (typeof f === 'string') return f
  return [f.confidenceProgression, ...(f.topMoments ?? []).map((m) => m.title)].filter(Boolean).join(' ')
}

function sessionStageIssues(run) {
  const issues = []
  const fb = run.stages?.feedback
  if (!fb?.pass && fb?.score == null) issues.push('[Feedback] No overall_score returned')
  if (fb?.score === 0) {
    issues.push('[Feedback] Scoring withheld (short-form / no-data — not a calibrated low score)')
  } else if (fb?.score != null && fb.score < 10) {
    issues.push('[Feedback] Very low session score (<10)')
  }

  const anStatus = analysisStatus(run)
  if (anStatus === 'failed') issues.push('[Analysis] Pipeline failed')
  if (anStatus === 'timeout') issues.push('[Analysis] Poll timeout')
  if (anStatus === 'skipped-403') issues.push('[Analysis] Skipped (403 — feature flag off)')
  if (anStatus === 'completed') {
    const tl = run.stages.analysis?.data?.timeline?.length ?? 0
    if (tl === 0) issues.push('[Analysis] Completed but empty timeline')
    const text = fusionText(run.stages.analysis?.data)
    if (text.length < 40) issues.push('[Analysis] Thin fusion summary')
  }

  const pwState = pathwayState(run)
  const pwGen = pathwayGenerationStatus(run)
  if (pwGen === 'pending' || pwGen === 'running') {
    issues.push(`[Pathway] generationStatus=${pwGen} after poll window`)
  }
  if (pwGen === 'failed') issues.push('[Pathway] pathwayGenerationStatus=failed')
  if (pwState === 'pending' && pwGen !== 'pending' && pwGen !== 'running') {
    issues.push('[Pathway] View-model pending but generation terminal — UI lag?')
  }
  if (pwState === 'pending' && (pwGen === 'pending' || pwGen === 'running')) {
    issues.push('[Pathway] Still pending after poll window')
  }
  if (pwState === 'failed') issues.push('[Pathway] Generation failed')
  if (pwState === 'missing') issues.push('[Pathway] No pathway payload')

  const drill = run.stages?.drill
  if (drill?.skipped && run.matrixKey.endsWith('/weak') && (drill.weakCount ?? 0) === 0) {
    issues.push('[Drill] Skipped — no weak questions indexed for session')
  }
  if (!drill?.skipped && (drill?.sseEvents ?? 0) < 2) {
    issues.push('[Drill] SSE stream unusually short')
  }

  return issues
}

function buildSessionRows(runs, evalRowsByKey) {
  return runs.map((run) => {
    const { domain, depth, persona } = parseMatrixKey(run.matrixKey)
    const qRows = evalRowsByKey.get(run.matrixKey) ?? []
    const qAvgs = qRows.map((r) => r.avgDimensions).filter((n) => n != null)
    const sessionAvg =
      qAvgs.length > 0 ? Math.round(qAvgs.reduce((a, b) => a + b, 0) / qAvgs.length) : null
    const anData = run.stages?.analysis?.data
    const pwData = run.stages?.pathway?.data
    const drill = run.stages?.drill ?? {}

    return {
      matrixKey: run.matrixKey,
      domain,
      depth,
      persona,
      sessionId: run.sessionId ?? '',
      harnessPass: run.pass === true,
      perQuestionPassCount: qRows.filter((r) => r.pass).length,
      sessionAvgDimensions: sessionAvg,
      feedbackScore: run.stages?.feedback?.score ?? null,
      feedbackPass: run.stages?.feedback?.pass === true,
      analysisStatus: analysisStatus(run),
      analysisTimelineEvents: anData?.timeline?.length ?? null,
      analysisDurationMs: anData?.processingDurationMs ?? null,
      analysisCostUsd: anData?.totalCostUsd ?? null,
      pathwayState: pathwayState(run),
      pathwayGenerationStatus: pathwayGenerationStatus(run),
      pathwayPlanEnqueue: pathwayPlanEnqueueStatus(run),
      pathwayPlanItems: pwData?.planItems?.length ?? null,
      pathwayMs: run.stages?.pathway?.ms ?? null,
      drillStatus: drillStatus(run),
      drillWeakCount: drill.weakCount ?? null,
      drillSseEvents: drill.sseEvents ?? null,
      stageIssues: sessionStageIssues(run),
    }
  })
}

function summarizeDownstream(sessionRows) {
  const analysisCompleted = sessionRows.filter((s) => s.analysisStatus === 'completed').length
  const analysisFailed = sessionRows.filter((s) => s.analysisStatus === 'failed').length
  const analysisSkipped = sessionRows.filter((s) => s.analysisStatus.startsWith('skipped')).length
  const analysisTimeout = sessionRows.filter((s) => s.analysisStatus === 'timeout').length

  const pathwayCompleted = sessionRows.filter((s) => s.pathwayState === 'completed').length
  const pathwayActive = sessionRows.filter((s) => s.pathwayState === 'active').length
  const pathwayPending = sessionRows.filter((s) => s.pathwayState === 'pending').length
  const pathwayFailed = sessionRows.filter((s) => s.pathwayState === 'failed').length

  const pathwayGenSucceeded = sessionRows.filter((s) => s.pathwayGenerationStatus === 'succeeded').length
  const pathwayGenPending = sessionRows.filter((s) => s.pathwayGenerationStatus === 'pending').length
  const pathwayGenRunning = sessionRows.filter((s) => s.pathwayGenerationStatus === 'running').length
  const pathwayGenFailed = sessionRows.filter((s) => s.pathwayGenerationStatus === 'failed').length
  const pathwayGenSkipped = sessionRows.filter((s) => s.pathwayGenerationStatus === 'skipped').length
  const pathwayGenCaptured = sessionRows.filter((s) => s.pathwayGenerationStatus != null).length

  const drillRan = sessionRows.filter((s) => s.drillStatus === 'completed').length
  const drillSkipped = sessionRows.filter((s) => s.drillStatus === 'skipped').length

  const analysisDurations = sessionRows
    .map((s) => s.analysisDurationMs)
    .filter((n) => n != null)
  const timelineCounts = sessionRows
    .map((s) => s.analysisTimelineEvents)
    .filter((n) => n != null)

  const stageIssueCounts = new Map()
  for (const s of sessionRows) {
    for (const i of s.stageIssues) stageIssueCounts.set(i, (stageIssueCounts.get(i) ?? 0) + 1)
  }

  return {
    analysisCompleted,
    analysisFailed,
    analysisSkipped,
    analysisTimeout,
    pathwayCompleted,
    pathwayActive,
    pathwayPending,
    pathwayFailed,
    pathwayGenSucceeded,
    pathwayGenPending,
    pathwayGenRunning,
    pathwayGenFailed,
    pathwayGenSkipped,
    pathwayGenCaptured,
    drillRan,
    drillSkipped,
    analysisDurationP50: p50(analysisDurations),
    analysisDurationP95: p95(analysisDurations),
    timelineEventsP50: p50(timelineCounts),
    stageIssueCounts: [...stageIssueCounts.entries()].sort((a, b) => b[1] - a[1]),
  }
}

// Enrich evaluation rows
const evaluationRows = (raw.evaluationRows ?? []).map((row) => {
  const parts = row.run.split('/')
  return {
    matrixKey: row.run,
    domain: parts[0],
    depth: parts[1],
    persona: row.persona,
    questionIndex: row.qi ?? row.q - 1,
    relevance: evNum(row.eval?.relevance),
    structure: evNum(row.eval?.structure),
    specificity: evNum(row.eval?.specificity),
    ownership: evNum(row.eval?.ownership),
    jdAlignment: evNum(row.eval?.jdAlignment),
    avgDimensions: row.avg ?? avgDim(row.eval),
    pass: row.bandOk === true,
    g3Relevance: row.g3Relevance ?? row.gates?.g3Relevance ?? null,
    answerRoute: row.answerRoute ?? null,
    competencyBucket: row.flowMeta?.competencyBucket ?? null,
    slotId: row.flowMeta?.slotId ?? null,
    generateLatencyMs: row.genMs ?? null,
    evalLatencyMs: row.evalMs ?? null,
    issues: mapQualityCriteria(row),
    _raw: row,
  }
})

const evalRowsByKey = new Map()
for (const row of evaluationRows) {
  const list = evalRowsByKey.get(row.matrixKey) ?? []
  list.push(row)
  evalRowsByKey.set(row.matrixKey, list)
}

// Aggregate issue counts
const issueCounts = new Map()
for (const r of evaluationRows) {
  for (const i of r.issues) issueCounts.set(i, (issueCounts.get(i) ?? 0) + 1)
}
const topIssues = [...issueCounts.entries()].sort((a, b) => b[1] - a[1])

// Latency stats
const genMs = evaluationRows.map((r) => r.generateLatencyMs).filter((n) => n != null)
const evalMs = evaluationRows.map((r) => r.evalLatencyMs).filter((n) => n != null)

// Run-level stats
const runs = raw.runs ?? []
const strongRuns = runs.filter((r) => r.matrixKey.endsWith('/strong'))
const weakRuns = runs.filter((r) => r.matrixKey.endsWith('/weak'))
const feedbackScores = runs.map((r) => r.stages?.feedback?.score).filter((s) => s != null)

const sessionRows = buildSessionRows(runs, evalRowsByKey)
const downstream = summarizeDownstream(sessionRows)

const autoFindings = buildAutoFindings(sessionRows, downstream, evaluationRows, {
  strongPass: strongRuns.filter((r) => r.pass).length,
  weakPass: weakRuns.filter((r) => r.pass).length,
  totalRuns: runs.length,
})
const allFindings = triageSummary?.findings ?? [...manualFindings, ...autoFindings]

function isActiveP0(f) {
  return f.severity === 'P0' && f.status !== 'resolved' && f.status !== 'wont-fix'
}

function isActivePathwayP0(f) {
  return isActiveP0(f) && f.stage === 'pathway'
}
const scorecard = buildScorecard(sessionRows, downstream, {
  strongPass: strongRuns.filter((r) => r.pass).length,
  weakPass: weakRuns.filter((r) => r.pass).length,
  totalRuns: runs.length,
  passedRuns: raw.passedRuns,
})

function buildAutoFindings(sessionRows, downstream, evalRows, stats) {
  const findings = []
  const n = sessionRows.length

  const genPending = downstream.pathwayGenCaptured
    ? downstream.pathwayGenPending + downstream.pathwayGenRunning
    : downstream.pathwayPending
  const genSucceeded = downstream.pathwayGenCaptured
    ? downstream.pathwayGenSucceeded + downstream.pathwayGenSkipped
    : downstream.pathwayCompleted + downstream.pathwayActive

  if (genPending === n && n > 0 && genSucceeded === 0) {
    findings.push({
      id: 'AUTO-PWY-001',
      severity: 'P0',
      stage: 'pathway',
      title: 'Pathway generation never reached terminal success in harness',
      status: 'confirmed-auto',
      impact: downstream.pathwayGenCaptured
        ? `${genPending}/${n} sessions stuck at pathwayGenerationStatus pending/running after poll window.`
        : `${downstream.pathwayPending}/${n} sessions stuck in view-model state "pending" after poll window.`,
      evidence: downstream.pathwayGenCaptured
        ? [
            `pathwayGenerationStatus succeeded/skipped: ${genSucceeded}/${n}`,
            `pathwayGenerationStatus pending/running: ${genPending}/${n}`,
            'See sessions.csv pathwayGenerationStatus column',
          ]
        : [
            `Harness poll: 0/${n} pathway state=completed`,
            `${downstream.pathwayPending}/${n} pathway state=pending`,
            'Harness v1 — upgrade to v2 to capture pathwayGenerationStatus',
          ],
      nextSteps: [
        'Inngest Cloud: verify pathway-regenerate function registered (expect 8 functions)',
        'Mongo: pathwayGenerationStatus, pathwayGenerationStartedAt, attempts',
        'See modules/qa/docs/PATHWAY_P0_TRACE.md',
      ],
    })
  }

  const strongEvalRows = evalRows.filter((r) => r.persona === 'strong')
  const strongRegarding = strongEvalRows.filter((r) =>
    String(r._raw?.answer ?? '').includes('Regarding "'),
  ).length
  if (stats.strongPass === 0 && stats.totalRuns >= 30) {
    findings.push({
      id: 'AUTO-HAR-001',
      severity: 'P2',
      stage: 'interview',
      title: strongRegarding > strongEvalRows.length * 0.5
        ? 'Strong persona 0% harness pass — canned-answer artifact'
        : 'Strong persona 0% harness pass — investigate eval or answers',
      status: strongRegarding > strongEvalRows.length * 0.5 ? 'harness-artifact' : 'suspected',
      impact: strongRegarding > strongEvalRows.length * 0.5
        ? 'Do not treat as eval regression; strong answers were pasted off-topic.'
        : 'Strong persona band check failed despite harness v2 on-topic answers.',
      evidence: [
        `0/${stats.totalRuns / 2} strong runs passed band (expected ≥60 avg)`,
        strongRegarding > 0
          ? `${strongRegarding}/${strongEvalRows.length} strong answers contain "Regarding …" hook`
          : 'Harness v2 — strong answers without Regarding hook',
      ],
      nextSteps: strongRegarding > strongEvalRows.length * 0.5
        ? ['Re-run with harness v2 (on-topic strong answers) before filing eval bugs']
        : ['Review evaluate-answer prompt calibration', 'Human-rate 5 strong samples'],
    })
  }

  const lowStructure = evalRows.filter((r) => (r.structure ?? 100) < 30).length
  if (lowStructure > evalRows.length * 0.8) {
    findings.push({
      id: 'AUTO-EVL-001',
      severity: 'P1',
      stage: 'interview',
      title: 'Structure dimension clustered below 30 on most evaluations',
      status: 'suspected',
      impact: 'Users may see uniformly low structure scores regardless of answer quality.',
      evidence: [`${lowStructure}/${evalRows.length} eval rows with structure < 30`],
      nextSteps: ['Review evaluate-answer prompt STAR calibration', 'Compare with human-rated sample'],
    })
  }

  return findings
}

function buildScorecard(sessionRows, downstream, stats) {
  const n = sessionRows.length
  const fbOk = sessionRows.filter((s) => s.feedbackPass).length
  const pathwayOk = sessionRows.filter((s) => {
    if (s.pathwayGenerationStatus === 'succeeded' || s.pathwayGenerationStatus === 'skipped') return true
    return s.pathwayState === 'completed' || s.pathwayState === 'active'
  }).length
  const hasP0Pathway = allFindings.some(isActivePathwayP0)
  const pathwayMetric = downstream.pathwayGenCaptured
    ? `${downstream.pathwayGenSucceeded + downstream.pathwayGenSkipped}/${n} gen succeeded/skipped`
    : `${pathwayOk}/${n} active or completed`
  const pathwayNotes = hasP0Pathway
    ? 'Pathway P0 — generation not completing'
    : downstream.pathwayGenCaptured && pathwayOk === n
      ? 'All sessions reached terminal pathway success'
      : downstream.pathwayGenCaptured
        ? `view-model pending: ${downstream.pathwayPending}/${n}`
        : `${downstream.pathwayPending}/${n} pending`

  return [
    {
      stage: 'interview',
      rag: stats.strongPass === 0 ? '🟡' : stats.passedRuns === stats.totalRuns ? '🟢' : '🟡',
      metric: `${stats.passedRuns}/${stats.totalRuns} harness pass`,
      notes:
        raw.harnessVersion?.startsWith('2.4')
          ? 'G1 pipeline + G2 weak separation; G3 strong relevance tracked separately'
          : 'Weak persona separates; strong fails on canned paste (see AUTO-HAR-001)',
    },
    {
      stage: 'feedback',
      rag: fbOk === n ? '🟢' : '🔴',
      metric: `${fbOk}/${n} returned overall_score`,
      notes: 'Scores low (2–24) — expected for weak/off-topic scripted answers',
    },
    {
      stage: 'analysis',
      rag: downstream.analysisCompleted === n ? '🟢' : downstream.analysisFailed > 0 ? '🔴' : '🟡',
      metric: `${downstream.analysisCompleted}/${n} completed`,
      notes: downstream.analysisDurationP50 ? `p50 ${downstream.analysisDurationP50}ms` : '',
    },
    {
      stage: 'pathway',
      rag: hasP0Pathway ? '🔴' : pathwayOk === n ? '🟢' : '🟡',
      metric: pathwayMetric,
      notes: pathwayNotes,
    },
    {
      stage: 'drill',
      rag: downstream.drillRan > 0 ? '🟡' : '⚪',
      metric: `${downstream.drillRan}/${n} SSE ran`,
      notes: `${downstream.drillSkipped} skipped (strong persona + no weak Qs)`,
    },
  ]
}

// Pick representative samples
function pickSamples() {
  const samples = []
  const byKey = (run, qi) => evaluationRows.find((r) => r.matrixKey === run && r.questionIndex === qi)

  const add = (id, row, verdict) => {
    if (!row) return
    const rawRow = row._raw ?? row
    samples.push({ id, verdict, row: rawRow })
  }

  add('A-off-topic-strong', byKey('frontend/behavioral/strong', 0), 'LLM eval working; harness canned answer off-topic')
  add('B-weak-correct', byKey('frontend/behavioral/weak', 0), 'Correctly low scores for vague answer')
  add('C-tech-mismatch', byKey('frontend/technical/strong', 0), 'Relevance collapse when answer mismatches React question')

  const highestStrong = [...evaluationRows]
    .filter((r) => r.persona === 'strong')
    .sort((a, b) => (b.avgDimensions ?? 0) - (a.avgDimensions ?? 0))[0]
  add(
    'D-best-strong-still-fail',
    highestStrong,
    `Highest strong avg ${highestStrong?.avgDimensions ?? '—'} — still below 60 band`,
  )

  const bestQuestion = [...evaluationRows].sort((a, b) => b._raw.question.length - a._raw.question.length)[0]
  add('E-rich-question', bestQuestion, 'Question gen: long, contextual, domain-specific')

  const slowGen = [...evaluationRows].sort(
    (a, b) => (b.generateLatencyMs ?? 0) - (a.generateLatencyMs ?? 0),
  )[0]
  add('F-slow-gen', slowGen, `Slowest gen ${slowGen?.generateLatencyMs}ms`)

  const probePivot = evaluationRows.find((r) => r._raw.eval?.probeDecision?.isPivot)
  add('G-probe-pivot', probePivot, 'Eval recommends pivot — live UI should change topic')

  const weakHigh = evaluationRows.filter((r) => r.persona === 'weak' && (r.avgDimensions ?? 0) > 20)
  if (weakHigh[0]) add('H-weak-not-low-enough', weakHigh[0], 'Possible over-scoring of weak answers')

  const pathwayPending = sessionRows.find((s) => s.pathwayState === 'pending')
  if (pathwayPending) {
    const run = runs.find((r) => r.matrixKey === pathwayPending.matrixKey)
    const tl = run?.stages?.analysis?.data?.timeline?.[0]
    samples.push({
      id: 'I-pathway-pending',
      verdict: 'Pathway still pending after 120s poll — feedback done, plan not finalized',
      row: {
        run: pathwayPending.matrixKey,
        persona: pathwayPending.persona,
        q: 1,
        avg: pathwayPending.sessionAvgDimensions,
        bandOk: pathwayPending.harnessPass,
        question: tl?.title ?? '(see session summary)',
        answer: tl?.description ?? pwDataSnippet(run),
        eval: {},
        genMs: null,
        evalMs: null,
      },
    })
  }

  const drillRan = sessionRows.find((s) => s.drillStatus === 'completed')
  if (drillRan) {
    samples.push({
      id: 'J-drill-ran',
      verdict: `Drill SSE ran (${drillRan.drillSseEvents} events, ${drillRan.drillWeakCount} weak Qs indexed)`,
      row: {
        run: drillRan.matrixKey,
        persona: drillRan.persona,
        q: 1,
        avg: drillRan.sessionAvgDimensions,
        bandOk: drillRan.harnessPass,
        question: 'Drill evaluate SSE',
        answer: `weakCount=${drillRan.drillWeakCount}, sseEvents=${drillRan.drillSseEvents}`,
        eval: {},
        genMs: null,
        evalMs: null,
      },
    })
  }

  return samples.filter((s) => s.row)
}

function pwDataSnippet(run) {
  const pw = run?.stages?.pathway?.data
  return pw?.nextAction?.description ?? ''
}

const samples = pickSamples()

// Per-question CSV
const csvHeader =
  'matrixKey,domain,depth,persona,questionIndex,relevance,structure,specificity,ownership,jdAlignment,avgDimensions,pass,generateLatencyMs,evalLatencyMs,qualityCriteria'
const csvLines = evaluationRows.map((r) =>
  [
    r.matrixKey,
    r.domain,
    r.depth,
    r.persona,
    r.questionIndex + 1,
    r.relevance ?? '',
    r.structure ?? '',
    r.specificity ?? '',
    r.ownership ?? '',
    r.jdAlignment ?? '',
    r.avgDimensions ?? '',
    r.pass ? 'PASS' : 'FAIL',
    r.generateLatencyMs ?? '',
    r.evalLatencyMs ?? '',
    `"${r.issues.join('; ').replace(/"/g, '""')}"`,
  ].join(','),
)

// Session-level CSV
const sessionsCsvHeader =
  'matrixKey,domain,depth,persona,sessionId,harnessPass,perQuestionPassCount,sessionAvgDimensions,feedbackScore,feedbackPass,analysisStatus,analysisTimelineEvents,analysisDurationMs,pathwayState,pathwayGenerationStatus,pathwayPlanEnqueue,pathwayPlanItems,drillStatus,drillWeakCount,drillSseEvents,stageIssues'
const sessionsCsvLines = sessionRows.map((s) =>
  [
    s.matrixKey,
    s.domain,
    s.depth,
    s.persona,
    s.sessionId,
    s.harnessPass ? 'PASS' : 'FAIL',
    s.perQuestionPassCount,
    s.sessionAvgDimensions ?? '',
    s.feedbackScore ?? '',
    s.feedbackPass ? 'yes' : 'no',
    s.analysisStatus,
    s.analysisTimelineEvents ?? '',
    s.analysisDurationMs ?? '',
    s.pathwayState,
    s.pathwayGenerationStatus ?? '',
    s.pathwayPlanEnqueue ?? '',
    s.pathwayPlanItems ?? '',
    s.drillStatus,
    s.drillWeakCount ?? '',
    s.drillSseEvents ?? '',
    `"${s.stageIssues.join('; ').replace(/"/g, '""')}"`,
  ].join(','),
)

const outDir = join(root, 'modules/qa/output')
mkdirSync(outDir, { recursive: true })
const id = raw.reportId
const mdPath = join(outDir, `${id}.md`)
const csvPath = join(outDir, `${id}-evaluations.csv`)
const sessionsCsvPath = join(outDir, `${id}-sessions.csv`)

const md = formatMarkdown(raw, evaluationRows, topIssues, samples, sessionRows, downstream, allFindings, scorecard, {
  genP50: p50(genMs),
  genP95: p95(genMs),
  evalP50: p50(evalMs),
  evalP95: p95(evalMs),
  strongPass: strongRuns.filter((r) => r.pass).length,
  weakPass: weakRuns.filter((r) => r.pass).length,
  feedbackScores,
  telemetrySummary,
  telemetryCount: telemetry.length,
  triageSummary,
  baselineDiffDoc,
  inputDir,
})

writeFileSync(mdPath, md, 'utf-8')
writeFileSync(csvPath, [csvHeader, ...csvLines].join('\n'), 'utf-8')
writeFileSync(sessionsCsvPath, [sessionsCsvHeader, ...sessionsCsvLines].join('\n'), 'utf-8')

const findingsCsvHeader = 'id,severity,stage,title,status,impact,evidence,nextSteps'
const findingsCsvLines = allFindings.map((f) =>
  [
    f.id,
    f.severity,
    f.stage,
    `"${(f.title ?? '').replace(/"/g, '""')}"`,
    f.status,
    `"${(f.impact ?? '').replace(/"/g, '""')}"`,
    `"${(f.evidence ?? []).join(' | ').replace(/"/g, '""')}"`,
    `"${(f.nextSteps ?? []).join(' | ').replace(/"/g, '""')}"`,
  ].join(','),
)
const findingsCsvPath = join(outDir, `${id}-findings.csv`)
writeFileSync(findingsCsvPath, [findingsCsvHeader, ...findingsCsvLines].join('\n'), 'utf-8')

if (telemetry.length) {
  const runOutDir = join(outDir, 'runs', id)
  writeTelemetryArtifacts(runOutDir, telemetry)
  const telemetryCsvHeader =
    'activityId,matrixKey,stage,step,verdict,durationMs,httpStatus,sessionId,failedAssertions'
  const telemetryCsvPath = join(outDir, `${id}-telemetry.csv`)
  writeFileSync(telemetryCsvPath, [telemetryCsvHeader, ...telemetryCsvRows(telemetry)].join('\n'), 'utf-8')
  console.log(join(runOutDir, 'telemetry.jsonl'))
  console.log(telemetryCsvPath)
}

console.log(mdPath)
console.log(csvPath)
console.log(sessionsCsvPath)
console.log(findingsCsvPath)
console.log(
  `Findings: ${allFindings.length}, Samples: ${samples.length}, Eval rows: ${evaluationRows.length}, Sessions: ${sessionRows.length}`,
)

function formatMarkdown(raw, rows, topIssues, samples, sessionRows, downstream, findings, scorecard, stats) {
  const L = []
  const p0 = findings.filter(isActiveP0)
  const resolvedP0 = findings.filter((f) => f.severity === 'P0' && f.status === 'resolved')

  L.push('# QA Matrix Report')
  L.push('')
  L.push('> Structured report — see `modules/qa/docs/REPORT_STRUCTURE.md` for the framework.')
  L.push('')
  L.push('## Table of contents')
  L.push('')
  L.push('1. [Metadata & scorecard](#1-metadata--scorecard)')
  L.push('2. [Ship blockers (P0)](#2-ship-blockers-p0)')
  L.push('3. [Findings register](#3-findings-register)')
  L.push('4. [Pipeline deep-dives](#4-pipeline-deep-dives)')
  L.push('5. [Harness calibration](#5-harness-calibration-not-product-bugs)')
  L.push('6. [Performance](#6-performance)')
  L.push('7. [Appendices](#7-appendices)')
  L.push('')

  // §1 Metadata & scorecard
  L.push('## 1. Metadata & scorecard')
  L.push('')
  L.push('| Field | Value |')
  L.push('|-------|-------|')
  L.push(`| Report ID | \`${raw.reportId}\` |`)
  L.push(`| Harness version | ${raw.harnessVersion ?? '1.x (legacy)'} |`)
  L.push(`| Mode | ${raw.mode} |`)
  L.push(`| Base URL | https://www.interviewprep.guru |`)
  L.push(`| Harness pass rate | ${raw.passedRuns}/${raw.totalRuns} (${(raw.passRate * 100).toFixed(1)}%) |`)
  L.push(`| Finished | ${raw.finishedAt ?? '—'} |`)
  L.push(`| P0 count | ${p0.length} |`)
  if (resolvedP0.length) {
    L.push(`| Resolved P0 (historical) | ${resolvedP0.map((f) => f.id).join(', ')} |`)
  }
  L.push('')
  L.push('### Pipeline scorecard')
  L.push('')
  L.push('| Stage | Status | Metric | Notes |')
  L.push('|-------|--------|--------|-------|')
  for (const row of scorecard) {
    L.push(`| ${row.stage} | ${row.rag} | ${row.metric} | ${row.notes} |`)
  }
  L.push('')

  // §2 Ship blockers
  L.push('## 2. Ship blockers (P0)')
  L.push('')
  if (p0.length === 0) {
    L.push('_No active P0 findings in this run._')
    if (resolvedP0.length) {
      L.push('')
      L.push(`> Historical P0 resolved: ${resolvedP0.map((f) => f.id).join(', ')}`)
    }
    L.push('')
  } else {
    for (const f of p0) {
      L.push(`### ${f.id}: ${f.title}`)
      L.push('')
      L.push(`| | |`)
      L.push(`|---|---|`)
      L.push(`| **Stage** | ${f.stage} |`)
      L.push(`| **Status** | ${f.status} |`)
      L.push(`| **Impact** | ${f.impact} |`)
      L.push('')
      L.push('**Evidence**')
      for (const e of f.evidence ?? []) L.push(`- ${e}`)
      L.push('')
      L.push('**Next steps**')
      for (const s of f.nextSteps ?? []) L.push(`- ${s}`)
      L.push('')
    }
  }

  // §3 Findings register
  L.push('## 3. Findings register')
  L.push('')
  L.push('| ID | Sev | Stage | Finding | Status |')
  L.push('|----|-----|-------|---------|--------|')
  for (const f of findings) {
    L.push(`| ${f.id} | ${f.severity} | ${f.stage} | ${f.title.replace(/\|/g, '/')} | ${f.status} |`)
  }
  L.push('')
  L.push(`> Export: \`${id}-findings.csv\``)
  if (stats.triageSummary) {
    L.push(`> Triage: \`runs/${raw.reportId ?? id}/triage-summary.json\``)
  }
  L.push('')

  if (stats.baselineDiffDoc && !stats.baselineDiffDoc.error) {
    L.push(formatDiffMarkdown(stats.baselineDiffDoc))
    L.push('')
  }

  if (stats.triageSummary?.recommendations?.length) {
    L.push('### Triage recommendations')
    L.push('')
    for (const r of stats.triageSummary.recommendations) {
      L.push(`- **${r.action}** — ${r.reason}`)
    }
    L.push('')
  }

  // §4 Pipeline deep-dives
  L.push('## 4. Pipeline deep-dives')
  L.push('')

  L.push('### 4.1 Interview (question gen + eval)')
  L.push('')
  L.push(`- Harness pass: **${stats.strongPass}/30 strong**, **${stats.weakPass}/30 weak** (persona band check)`)
  L.push('- Question quality: generally long, contextual, depth-appropriate')
  L.push('- Top eval criteria:')
  for (const [issue, count] of topIssues.slice(0, 8)) {
    L.push(`  - ${issue} (${count}×)`)
  }
  L.push('')

  L.push('### 4.2 Feedback')
  L.push('')
  if (stats.feedbackScores.length) {
    const min = Math.min(...stats.feedbackScores)
    const max = Math.max(...stats.feedbackScores)
    const mean = Math.round(stats.feedbackScores.reduce((a, b) => a + b, 0) / stats.feedbackScores.length)
    L.push(`- **${stats.feedbackScores.length}/${sessionRows.length}** sessions returned \`overall_score\``)
    L.push(`- Range **${min}–${max}**, mean **${mean}**`)
    L.push('- Full feedback prose not stored in browser JSON — score only')
  }
  L.push('')

  L.push('### 4.3 Analysis (multimodal fusion)')
  L.push('')
  L.push('| Metric | Value |')
  L.push('|--------|-------|')
  L.push(`| Completed | ${downstream.analysisCompleted}/${sessionRows.length} |`)
  L.push(`| Failed | ${downstream.analysisFailed} |`)
  L.push(`| Timeline events (p50) | ${downstream.timelineEventsP50} |`)
  L.push(`| Duration p50 / p95 | ${downstream.analysisDurationP50}ms / ${downstream.analysisDurationP95}ms |`)
  L.push('')

  L.push('### 4.4 Pathway (learning plan)')
  L.push('')
  if (downstream.pathwayGenCaptured) {
    L.push('| pathwayGenerationStatus | Count |')
    L.push('|-------------------------|-------|')
    L.push(`| succeeded | ${downstream.pathwayGenSucceeded} |`)
    L.push(`| skipped | ${downstream.pathwayGenSkipped} |`)
    L.push(`| pending | ${downstream.pathwayGenPending} |`)
    L.push(`| running | ${downstream.pathwayGenRunning} |`)
    L.push(`| failed | ${downstream.pathwayGenFailed} |`)
    L.push('')
  }
  L.push('| View-model state | Count |')
  L.push('|------------------|-------|')
  L.push(`| pending | ${downstream.pathwayPending} |`)
  L.push(`| active | ${downstream.pathwayActive} |`)
  L.push(`| completed | ${downstream.pathwayCompleted} |`)
  L.push(`| failed | ${downstream.pathwayFailed} |`)
  L.push('')
  L.push('**Product expectation:** after feedback, `pathwayGenerationStatus` should reach `succeeded` and the plan should reflect the new session.')
  L.push('')
  if (downstream.pathwayGenCaptured && downstream.pathwayGenSucceeded + downstream.pathwayGenSkipped >= sessionRows.length * 0.95) {
    L.push('**Observed:** generation reached terminal success on most sessions.')
  } else if (downstream.pathwayPending === sessionRows.length) {
    L.push('**Observed:** view-model stays `pending`; check Inngest worker + pathwayGenerationStatus.')
  } else {
    L.push('**Observed:** mixed pathway states — see sessions.csv for per-session detail.')
  }
  L.push('')
  L.push('**Investigation checklist:**')
  L.push('- [ ] `InterviewSession.pathwayGenerationStatus` stuck at `pending` / `running`?')
  L.push('- [ ] Inngest pathway regeneration job enqueued after feedback (`pathwayPlan` sideEffect scheduled)?')
  L.push('- [ ] `getCurrentPathway(userId)` returning stale plan vs session-scoped plan?')
  L.push('- [ ] `pathwayRegeneration.ts` error path setting `failed` silently?')
  L.push('')

  L.push('### 4.5 Drill mode')
  L.push('')
  L.push(`- SSE evaluate ran: **${downstream.drillRan}/${sessionRows.length}**`)
  L.push(`- Skipped: **${downstream.drillSkipped}** (strong persona always; weak when no indexed weak Qs)`)
  L.push('')

  // §5 Harness calibration
  L.push('## 5. Harness calibration (NOT product bugs)')
  L.push('')
  L.push('These patterns come from **how the matrix was run**, not necessarily product regressions:')
  L.push('')
  L.push('| Pattern | Interpretation |')
  L.push('|---------|----------------|')
  L.push('| Strong 0/30 harness pass | v1: canned `"Regarding …"` hook off-topic; v2: on-topic STAR paste |')
  L.push('| 179/180 structure < 30 | May be eval calibration; verify with human-rated on-topic answers |')
  L.push('| Low feedback scores (2–24) | Consistent with weak persona + off-topic strong paste |')
  L.push('')
  L.push('**Not tested this run:** live TTS, Deepgram STT, avatar, coaching nudges, probe follow-through in UI.')
  L.push('')

  // §6 Performance
  L.push('## 6. Performance')
  L.push('')
  L.push('| Endpoint | p50 | p95 |')
  L.push('|----------|-----|-----|')
  L.push(`| generate-question | ${stats.genP50}ms | ${stats.genP95}ms |`)
  L.push(`| evaluate-answer | ${stats.evalP50}ms | ${stats.evalP95}ms |`)
  L.push(`| analysis (session) | ${downstream.analysisDurationP50}ms | ${downstream.analysisDurationP95}ms |`)
  L.push('')

  if (stats.telemetrySummary) {
    L.push('## 7. Activity telemetry (harness v2.1+)')
    L.push('')
    L.push(`- **${stats.telemetryCount}** activities captured with console + network per step`)
    L.push(`- Verdicts: **${stats.telemetrySummary.pass} pass**, **${stats.telemetrySummary.warn} warn**, **${stats.telemetrySummary.fail} fail**`)
    L.push('')
    L.push('| Stage | pass | warn | fail | total |')
    L.push('|-------|------|------|------|-------|')
    for (const [stage, counts] of Object.entries(stats.telemetrySummary.byStage)) {
      L.push(`| ${stage} | ${counts.pass} | ${counts.warn} | ${counts.fail} | ${counts.total} |`)
    }
    L.push('')
    L.push('Artifacts: `*-telemetry.csv`, `runs/<reportId>/telemetry.jsonl`, `runs/<reportId>/activities/*.json`')
    L.push('')
  }

  // §8 Appendices (was §7)
  L.push('## 8. Appendices')
  L.push('')
  L.push('### A. Data files')
  L.push('')
  L.push(`| File | Rows | Purpose |`)
  L.push(`|------|------|---------|`)
  L.push(`| \`${id}-findings.csv\` | ${findings.length} | Ticket-ready findings register |`)
  L.push(`| \`${id}-sessions.csv\` | ${sessionRows.length} | One row per interview session |`)
  L.push(`| \`${id}-evaluations.csv\` | ${rows.length} | One row per question eval |`)
  L.push(`| \`${id}.json\` | — | Raw harness payload |`)
  if (stats.triageSummary) {
    L.push(`| \`runs/${raw.reportId ?? id}/triage-summary.json\` | — | Merged triage (Observer + Infra + auto) |`)
    L.push(`| \`runs/${raw.reportId ?? id}/baseline-diff.json\` | — | Metrics diff vs baseline |`)
    L.push(`| \`runs/${raw.reportId ?? id}/observations/\` | — | Observer classifications |`)
  }
  L.push('')

  L.push('### B. Session summary')
  L.push('')
  L.push('| Run | Harness | Q pass | Session avg | Feedback | Analysis | Pathway | Drill |')
  L.push('|-----|---------|--------|-------------|----------|----------|---------|-------|')
  for (const s of sessionRows) {
    L.push(
      `| ${s.matrixKey} | ${s.harnessPass ? '✅' : '❌'} | ${s.perQuestionPassCount}/3 | ${s.sessionAvgDimensions ?? '—'} | ${s.feedbackScore ?? '—'} | ${s.analysisStatus} | ${s.pathwayState} | ${s.drillStatus} |`,
    )
  }
  L.push('')

  L.push('### C. Representative samples')
  L.push('')
  for (const s of samples) {
    const row = s.row
    const ev = row.eval ?? {}
    L.push(`#### ${s.id}: ${s.verdict}`)
    L.push('')
    L.push(`**Run:** ${row.run} · **Persona:** ${row.persona} · **Q${row.q}** · **Avg:** ${row.avg ?? '—'}`)
    L.push('')
    L.push('**Question:**')
    L.push(`> ${row.question}`)
    L.push('')
    L.push('**Answer:**')
    L.push(`> ${row.answer.slice(0, 400)}${row.answer.length > 400 ? '…' : ''}`)
    L.push('')
    if (ev.relevance != null || row.genMs != null) {
      L.push('| Rel | Str | Spec | Own | Gen ms | Eval ms |')
      L.push('|-----|-----|------|-----|--------|---------|')
      L.push(`| ${ev.relevance ?? '—'} | ${ev.structure ?? '—'} | ${ev.specificity ?? '—'} | ${ev.ownership ?? '—'} | ${row.genMs ?? '—'} | ${row.evalMs ?? '—'} |`)
      L.push('')
    }
    if (ev.answerSummary) L.push(`**Eval summary:** ${ev.answerSummary}`)
    if (ev.probeDecision) {
      L.push(`**Probe:** ${ev.probeDecision.probeType} → "${ev.probeDecision.probeTarget}" (pivot=${ev.probeDecision.isPivot})`)
    }
    if (row.eval && Object.keys(row.eval).length) {
      L.push('')
      const criteria = mapQualityCriteria(row)
      L.push('**Criteria:** ' + criteria.slice(0, 4).join('; '))
    }
    L.push('')
  }

  L.push('### D. Full evaluation table')
  L.push('')
  L.push('| Run | Q | Persona | Avg | Pass | Top criteria |')
  L.push('|-----|---|---------|-----|------|--------------|')
  for (const r of rows) {
    const top = r.issues.slice(0, 2).join('; ') || '—'
    L.push(`| ${r.matrixKey} | ${r.questionIndex + 1} | ${r.persona} | ${r.avgDimensions ?? '—'} | ${r.pass ? '✅' : '❌'} | ${top.replace(/\|/g, '/')} |`)
  }
  L.push('')

  L.push('### E. Methodology')
  L.push('')
  L.push('- Black-box HTTP harness via logged-in browser on production')
  L.push('- 30 domain×depth pairs × 2 personas (strong / weak) = 60 sessions, 3 questions each')
  L.push('- Manual findings merged from `modules/qa/config/reportFindings.json`')
  L.push('- Regenerate: `npm run qa:report:browser [json-path]`')
  L.push('')

  return L.join('\n')
}
