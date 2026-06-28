#!/usr/bin/env node
/**
 * Expanded post-matrix quality gate — roster, duplicates, variant coverage, content audit.
 *
 * Usage:
 *   node scripts/qa-v3-quality.mjs <reportId>
 *   node scripts/qa-v3-quality.mjs <reportId> --strict
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadDotEnvLocal } from '../modules/qa/runner/loadEnv.mjs'
import { resolveReportJsonPath } from '../modules/qa/agents/baselineDiff.mjs'
import { loadMatrixReport, computeRunMetrics } from '../modules/qa/agents/runMetrics.mjs'
import { computeMatrixQuality, matrixQualityToFindings } from '../modules/qa/agents/matrixQuality.mjs'
import { runOutputDir } from '../modules/qa/orchestrator/runManifest.mjs'

loadDotEnvLocal()

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// First non-flag positional arg is the reportId — accept custom IDs (e.g. --report-id
// nightly-full-001), not only the default qa-browser-* ones. argv[0]=node, argv[1]=script.
const reportId = process.argv.slice(2).find((a) => !a.startsWith('-'))
const strict = process.argv.includes('--strict')

if (!reportId) {
  console.error('Usage: node scripts/qa-v3-quality.mjs <reportId> [--strict]')
  process.exit(1)
}

const reportPath = resolveReportJsonPath(reportId)
if (!reportPath) {
  console.error(`No matrix report for ${reportId}`)
  process.exit(1)
}

const report = loadMatrixReport(reportPath)
const runMetrics = computeRunMetrics(report)
const quality = computeMatrixQuality(report)
const findings = matrixQualityToFindings(quality)
const outDir = runOutputDir(reportId)
mkdirSync(outDir, { recursive: true })

const qualityReport = {
  reportId,
  checkedAt: new Date().toISOString(),
  runMetrics,
  quality,
  findings,
  checks: [],
}

function runCheck(name, fn) {
  console.log(`\n=== ${name} ===`)
  try {
    const result = fn()
    qualityReport.checks.push({ name, ok: result.ok !== false, ...result })
    if (result.ok === false) console.error(`FAIL: ${result.message}`)
    else console.log(result.message ?? 'OK')
    return result.ok !== false
  } catch (err) {
    qualityReport.checks.push({ name, ok: false, error: String(err.message || err) })
    console.error(`FAIL: ${err.message || err}`)
    return false
  }
}

let allOk = true

allOk = runCheck('Domain content audit (question bank)', () => {
  // In strict mode, propagate --strict so the audit FAILS the gate on coverage gaps
  // (without it the audit records gaps but exits 0, silently passing the strict check).
  const r = spawnSync('node', ['scripts/audit-domain-coverage.mjs', ...(strict ? ['--strict'] : [])], {
    cwd: root,
    encoding: 'utf-8',
    shell: process.platform === 'win32',
  })
  if (r.status !== 0) {
    return { ok: false, message: (r.stdout || r.stderr || '').trim().slice(-500) }
  }
  return { ok: true, message: '84/84 applicable combos covered in question bank' }
}) && allOk

allOk = runCheck('Roster completeness', () => {
  if (quality.expectedCells == null) {
    return { ok: true, message: `Smoke/partial mode — ${quality.actualCells} cells (no full roster expectation)` }
  }
  const ok = quality.rosterComplete
  return {
    ok,
    message: ok
      ? `${quality.actualCells}/${quality.expectedCells} cells present`
      : `${quality.missingCount} missing of ${quality.expectedCells} expected`,
  }
}) && allOk

allOk = runCheck('Duplicate questions (domain×depth)', () => {
  const ok = quality.duplicateCount === 0
  return {
    ok: strict ? ok : true,
    message: ok
      ? 'No cross-persona duplicates detected'
      : `${quality.duplicateCount} duplicate normalized question(s) — see AUTO-DUP-001`,
    duplicateCount: quality.duplicateCount,
  }
}) && allOk

allOk = runCheck('Academics opener (no favourite-subject re-ask)', () => {
  // Hard regression gate: a generated academics question that re-asks the spoken
  // favourite-subject opener is the exact bug AUTO-ACAD-001 guards. AUTO-ACAD-001 is only
  // P1, and the strict gate exits on !allOk / P0 — so without this check the regression
  // would pass --report/GA. Fail it in any mode (no academics cells ⇒ count 0 ⇒ passes).
  const ok = quality.academicOpenerCount === 0
  return {
    ok,
    message: ok
      ? 'No academics cell re-asked the favourite-subject opener'
      : `${quality.academicOpenerCount} academics cell(s) re-asked the opener — see AUTO-ACAD-001`,
    academicOpenerCount: quality.academicOpenerCount,
  }
}) && allOk

allOk = runCheck('Generate-question health', () => {
  const ok = quality.emptyQuestionCount === 0 && quality.genQ429Cells.length === 0
  return {
    ok,
    message: ok
      ? 'No empty cells or 429s'
      : `empty=${quality.emptyQuestionCount} 429-cells=${quality.genQ429Cells.length}`,
  }
}) && allOk

allOk = runCheck('Pass rate', () => {
  const min = report.mode === 'full' ? (strict ? 0.85 : 0.7) : 0.5
  const ok = quality.passRate >= min
  return {
    ok,
    message: `${(quality.passRate * 100).toFixed(1)}% (threshold ${(min * 100).toFixed(0)}%)`,
  }
}) && allOk

allOk = runCheck('Experience band', () => {
  const exp = quality.matrixExperience || 'unknown'
  const ok = exp === '0-2' || report.mode !== 'full'
  return { ok, message: `matrixExperience=${exp}` }
}) && allOk

if (report.mode === 'full') {
  allOk = runCheck('Strong-answer variant coverage', () => {
    const r = spawnSync('node', ['scripts/qa-check-variant-coverage.mjs', reportPath], {
      cwd: root,
      encoding: 'utf-8',
      shell: process.platform === 'win32',
    })
    const out = (r.stdout || '') + (r.stderr || '')
    const m = out.match(/Fell to default: (\d+) \((\d+)%\)/)
    const defaultPct = m ? parseInt(m[2], 10) : null
    const ok = r.status === 0 && (defaultPct == null || defaultPct < 40)
    return {
      ok: strict ? ok : r.status === 0,
      message: m ? `default variant rate ${defaultPct}%` : out.split('\n').slice(-4).join(' '),
      defaultPct,
    }
  }) && allOk
}

const qualityPath = join(outDir, 'quality-report.json')
writeFileSync(qualityPath, JSON.stringify(qualityReport, null, 2), 'utf-8')

console.log(`\n=== Quality summary ===`)
console.log(`Findings: ${findings.length} (${findings.filter((f) => f.severity === 'P0').length} P0)`)
console.log(`Wrote ${qualityPath}`)

if (strict && (!allOk || findings.some((f) => f.severity === 'P0'))) {
  process.exit(2)
}
process.exit(allOk ? 0 : 1)
