/**
 * Expanded matrix quality checks — roster coverage, duplicates, gen failures, pass rate.
 */
import { listMatrixCells, matrixCellCount } from '../orchestrator/rosterMatrix.mjs'

function normQuestion(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, '')
    .trim()
}

/**
 * Matches a GENERATED interviewer question that RE-ASKS the academics favourite-subject
 * opener (the duplication bug). The opener is the SPOKEN intro for academics, so no
 * generated question should ask "which subject are you strongest in / your favourite
 * subject / which subject you enjoy most". Deliberately does NOT match legitimate
 * references to the already-named subject (e.g. "in your strongest subject, derive…").
 */
const ACADEMIC_OPENER_RE =
  /(?:which|what)\s+(?:[a-z]+\s+){0,2}subject\s+(?:are|do|is)\s+you|what(?:['’]s| is)\s+your\s+(?:favou?rite|strongest)\s+subject|(?:which|what)\s+subject\s+do\s+you\s+(?:enjoy|prefer|like)|favou?rite\s+or\s+strongest\s+subject/i

/**
 * @param {object} report - matrix-report.json
 */
export function computeMatrixQuality(report) {
  const runs = report.runs ?? []
  const mode = report.mode ?? 'unknown'
  const expectedCells = mode === 'full' ? matrixCellCount('full') : null
  const expectedRunIds = mode === 'full' ? new Set(listMatrixCells('full').map((r) => r.runId)) : null

  const seenRunIds = new Set()
  const missingRunIds = []
  const emptyQuestionCells = []
  const genQ429Cells = []
  const byDomainDepth = new Map()
  const academicOpenerCells = []

  for (const run of runs) {
    if (run.runId) seenRunIds.add(run.runId)
    const key = run.matrixKey || ''
    const parts = key.split('/')
    const domainDepth = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : key
    const depth = parts[1] || ''

    const qs = (run.questions ?? [])
      .map((q) => q.question || q.text || '')
      .filter(Boolean)
    if (qs.length === 0 && !run.quotaAborted) {
      emptyQuestionCells.push(key || run.runId)
    }

    // Academics duplication guard: no GENERATED question may re-ask the favourite-subject
    // opener (it is the spoken intro). Flag the first offending generated question per cell.
    if (depth === 'academics') {
      const offender = qs.find((q) => ACADEMIC_OPENER_RE.test(q))
      if (offender) {
        academicOpenerCells.push({ matrixKey: key, question: offender.slice(0, 140) })
      }
    }

    if (!byDomainDepth.has(domainDepth)) byDomainDepth.set(domainDepth, [])
    for (const q of qs) {
      byDomainDepth.get(domainDepth).push({ q, norm: normQuestion(q), matrixKey: key })
    }
  }

  if (expectedRunIds) {
    for (const id of expectedRunIds) {
      if (!seenRunIds.has(id)) missingRunIds.push(id)
    }
  }

  const duplicateGroups = []
  for (const [domainDepth, items] of byDomainDepth) {
    const byNorm = new Map()
    for (const item of items) {
      if (!item.norm || item.norm.length < 20) continue
      if (!byNorm.has(item.norm)) byNorm.set(item.norm, [])
      byNorm.get(item.norm).push(item)
    }
    for (const [norm, group] of byNorm) {
      const keys = [...new Set(group.map((g) => g.matrixKey))]
      if (keys.length > 1) {
        duplicateGroups.push({
          domainDepth,
          norm,
          sample: group[0].q.slice(0, 120),
          matrixKeys: keys,
        })
      }
    }
  }

  const telemetry = report.telemetry ?? []
  const genQ429 = telemetry.filter(
    (t) =>
      t.stage === 'interview' &&
      (t.step === 'generate-question' || String(t.step || '').includes('generate')) &&
      (t.apiResult?.status === 429 || String(t.apiResult?.status) === '429'),
  )
  const genQ429Keys = [...new Set(genQ429.map((t) => t.matrixKey).filter(Boolean))]
  genQ429Cells.push(...genQ429Keys)

  const passRate = report.passRate ?? (runs.length ? runs.filter((r) => r.pass).length / runs.length : 0)
  const rosterComplete =
    expectedCells == null ? null : runs.length >= expectedCells && missingRunIds.length === 0

  return {
    mode,
    matrixExperience: report.matrixExperience ?? null,
    expectedCells,
    actualCells: runs.length,
    rosterComplete,
    missingRunIds,
    missingCount: missingRunIds.length,
    emptyQuestionCells,
    emptyQuestionCount: emptyQuestionCells.length,
    academicOpenerCells,
    academicOpenerCount: academicOpenerCells.length,
    duplicateGroups,
    duplicateCount: duplicateGroups.length,
    genQ429Count: genQ429.length,
    genQ429Cells: [...new Set(genQ429Cells)],
    passRate,
    strongPassRate:
      runs.filter((r) => r.matrixKey?.endsWith('/strong')).length > 0
        ? runs.filter((r) => r.matrixKey?.endsWith('/strong') && r.pass).length /
          runs.filter((r) => r.matrixKey?.endsWith('/strong')).length
        : null,
  }
}

/**
 * @param {ReturnType<typeof computeMatrixQuality>} quality
 */
export function matrixQualityToFindings(quality) {
  const findings = []

  if (quality.expectedCells != null && quality.missingCount > 0) {
    findings.push({
      id: 'AUTO-COV-001',
      severity: quality.missingCount > 10 ? 'P0' : 'P1',
      stage: 'matrix',
      title: `Roster incomplete — ${quality.missingCount} expected cells missing`,
      status: 'confirmed-auto',
      classification: 'harness-gap',
      impact: `Full matrix expected ${quality.expectedCells} cells; ${quality.actualCells} ran; ${quality.missingCount} missing.`,
      evidence: quality.missingRunIds.slice(0, 15),
      nextSteps: ['Check shard failures or quota abort', 'Re-run missing offsets with --resume'],
      source: 'matrix-quality',
    })
  }

  if (quality.emptyQuestionCount > 0) {
    findings.push({
      id: 'AUTO-GEN-001',
      severity: quality.emptyQuestionCount > 5 ? 'P0' : 'P1',
      stage: 'interview',
      title: 'Cells completed with zero generated questions',
      status: 'confirmed-auto',
      classification: 'product-bug',
      impact: `${quality.emptyQuestionCount} cells have no Q&A — likely generate-question 429/5xx or early abort.`,
      evidence: quality.emptyQuestionCells.slice(0, 15),
      nextSteps: [
        'Verify QA_AUTOMATION_ENABLED on Vercel',
        'Check /api/generate-question rate limits',
      ],
      source: 'matrix-quality',
    })
  }

  if (quality.genQ429Cells.length > 0) {
    findings.push({
      id: 'AUTO-GEN-002',
      severity: 'P0',
      stage: 'interview',
      title: 'generate-question rate limited (429)',
      status: 'confirmed-auto',
      classification: 'infra',
      impact: `${quality.genQ429Count} generate-question calls returned 429 across ${quality.genQ429Cells.length} cells.`,
      evidence: quality.genQ429Cells.slice(0, 15),
      nextSteps: ['Raise QA automation rate limit or slow matrix shards', 'Confirm QA_AUTOMATION_EMAIL allowlist'],
      source: 'matrix-quality',
    })
  }

  if (quality.academicOpenerCount > 0) {
    findings.push({
      id: 'AUTO-ACAD-001',
      severity: 'P1',
      stage: 'interview',
      title: 'Academics: generated question re-asked the favourite-subject opener',
      status: 'confirmed-auto',
      classification: 'product-bug',
      impact: `${quality.academicOpenerCount} academics cell(s) generated a question that re-asks "which subject are you strongest in" — the opener is the spoken intro, so this duplicates it (the academics Q1 duplication bug).`,
      evidence: quality.academicOpenerCells
        .slice(0, 10)
        .map((c) => `${c.matrixKey}: "${c.question}…"`),
      nextSteps: [
        'Check academicGroundingDirective anti-repeat guard in app/api/generate-question/route.ts (academicsPrompt.ts)',
        'Check {domain}-academics.md skill files did not reintroduce a "which subject" opener',
      ],
      source: 'matrix-quality',
    })
  }

  if (quality.duplicateCount > 0) {
    findings.push({
      id: 'AUTO-DUP-001',
      severity: quality.duplicateCount > 20 ? 'P1' : 'P2',
      stage: 'interview',
      title: 'Duplicate questions across personas/sessions for same domain×depth',
      status: 'suspected',
      classification: 'product-bug',
      impact: `${quality.duplicateCount} normalized question(s) repeated across different matrix cells with the same domain×depth.`,
      evidence: quality.duplicateGroups.slice(0, 8).map(
        (g) => `${g.domainDepth}: "${g.sample}…" in ${g.matrixKeys.join(', ')}`,
      ),
      nextSteps: [
        'Review buildAntiRepeatBlock coverage (Q0–Q1 only)',
        'Consider adding experience to anti-repeat query',
      ],
      source: 'matrix-quality',
    })
  }

  if (quality.mode === 'full' && quality.passRate < 0.7) {
    findings.push({
      id: 'AUTO-PASS-001',
      severity: 'P0',
      stage: 'matrix',
      title: 'Full matrix pass rate below 70%',
      status: 'confirmed-auto',
      classification: 'product-bug',
      impact: `Pass rate ${(quality.passRate * 100).toFixed(1)}% — release blocker for full roster.`,
      evidence: [`passed: ${Math.round(quality.passRate * quality.actualCells)}/${quality.actualCells}`],
      nextSteps: ['Triage failed cells by domain', 'Compare to prior baseline diff'],
      source: 'matrix-quality',
    })
  } else if (quality.mode === 'full' && quality.passRate < 0.85) {
    findings.push({
      id: 'AUTO-PASS-002',
      severity: 'P1',
      stage: 'matrix',
      title: 'Full matrix pass rate below 85%',
      status: 'confirmed-auto',
      classification: 'product-bug',
      impact: `Pass rate ${(quality.passRate * 100).toFixed(1)}% — investigate before GA.`,
      evidence: [`passed: ${Math.round(quality.passRate * quality.actualCells)}/${quality.actualCells}`],
      nextSteps: ['Group failures by depth type', 'Check AUTO-GEN and pathway findings'],
      source: 'matrix-quality',
    })
  }

  if (quality.matrixExperience && quality.matrixExperience !== '0-2') {
    findings.push({
      id: 'AUTO-EXP-001',
      severity: 'P2',
      stage: 'matrix',
      title: `Matrix ran with experience=${quality.matrixExperience}, expected 0-2`,
      status: 'harness-config',
      classification: 'harness-artifact',
      impact: 'Flow/skill templates may not match intended entry-level band.',
      evidence: [`matrixExperience: ${quality.matrixExperience}`],
      nextSteps: ['Re-run with --experience 0-2 or full profile default'],
      source: 'matrix-quality',
    })
  }

  return findings
}
