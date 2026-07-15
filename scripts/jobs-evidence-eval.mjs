#!/usr/bin/env node
/**
 * Golden-set calibration harness for jobs.evidence-attribution
 * (READINESS.md §1 — the PR-R2 ENTRY GATE: no band renders until this
 * passes). Manual, env-gated, never CI.
 *
 * Usage: JOBS_EVIDENCE_EVAL=1 OPENAI_API_KEY=... node scripts/jobs-evidence-eval.mjs
 *
 * Fixtures: modules/jobs/eval/evidenceGoldenSet.json — hand-labeled
 * (answer, requirement) → strength triples sourced from the founder's own
 * prod sessions (~30 items). Gate: agreement ≥ 80% on strength (strong/
 * partial/none collapsed to evidence-vs-none must agree ≥ 90%).
 *
 * Re-run on ANY change to the jobs.evidence-attribution slot model.
 */
import { readFileSync } from 'fs'

if (process.env.JOBS_EVIDENCE_EVAL !== '1') {
  console.log('JOBS_EVIDENCE_EVAL != 1 — this harness is manual-only. Exiting.')
  process.exit(0)
}

let fixtures
try {
  fixtures = JSON.parse(readFileSync(new URL('../modules/jobs/eval/evidenceGoldenSet.json', import.meta.url), 'utf8'))
} catch {
  fixtures = []
}
if (!Array.isArray(fixtures) || fixtures.length === 0) {
  console.log('evidenceGoldenSet.json is empty — label ~30 (answer, requirement, strength) triples')
  console.log('from prod sessions before PR-R2 ships (READINESS.md §1 calibration gate).')
  process.exit(1)
}

console.log(`${fixtures.length} fixtures loaded — live-call scoring not yet wired (lands with the labeled set).`)
process.exit(1)
