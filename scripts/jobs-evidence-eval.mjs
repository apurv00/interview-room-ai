#!/usr/bin/env node
/**
 * Golden-set calibration harness for jobs.evidence-attribution
 * (READINESS.md §1 — the PR-R2 ENTRY GATE: no band renders until this
 * passes). Manual, env-gated, never CI.
 *
 * Usage:
 *   JOBS_EVIDENCE_EVAL_EXPECTED_MODEL=gpt-5.6-luna \
 *   JOBS_EVIDENCE_EVAL_EXPECTED_PROVIDER=openai \
 *   MONGODB_URI=... \
 *   OPENAI_API_KEY=... npm run eval:jobs-evidence
 *
 * Fixtures: modules/jobs/eval/evidenceGoldenSet.json — founder-consented,
 * manually redacted full-session cases with consent records held outside Git.
 * The live test owns the complete threshold contract and writes only a
 * redacted diagnostic or technical-pass artifact.
 *
 * Re-run on ANY change to the jobs.evidence-attribution slot model.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const EXPECTED_MODEL_ENV = 'JOBS_EVIDENCE_EVAL_EXPECTED_MODEL'
const EXPECTED_PROVIDER_ENV = 'JOBS_EVIDENCE_EVAL_EXPECTED_PROVIDER'
const PROVIDER_KEYS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_AI_API_KEY',
  'GROQ_API_KEY',
]

let fixtures
try {
  fixtures = JSON.parse(readFileSync(new URL('../modules/jobs/eval/evidenceGoldenSet.json', import.meta.url), 'utf8'))
} catch {
  fixtures = []
}
const labeledPairs = Array.isArray(fixtures)
  ? fixtures.reduce((count, fixture) => count + (Array.isArray(fixture?.labels) ? fixture.labels.length : 0), 0)
  : 0
if (!Array.isArray(fixtures) || fixtures.length < 5 || labeledPairs < 30) {
  console.error('Evidence calibration gate is closed: need at least 5 full-context cases and 30 labeled pairs.')
  console.error(`Found ${Array.isArray(fixtures) ? fixtures.length : 0} cases and ${labeledPairs} labeled pairs.`)
  console.error('Label the founder-consented, manually redacted corpus before PR-R2 renders any readiness band (READINESS.md §1).')
  process.exit(1)
}

// Shape validation is local and secret-free. Run it before checking live-call
// credentials so an invalid corpus fails with the actionable fixture error.
const shape = spawnSync(
  'npx',
  ['vitest', 'run', 'modules/jobs/__tests__/goldenSetShape.test.ts'],
  { stdio: 'inherit', env: process.env },
)
if ((shape.status ?? 1) !== 0) process.exit(shape.status ?? 1)

const cleanTree = spawnSync(
  'git',
  ['status', '--porcelain=v1', '--untracked-files=all'],
  { encoding: 'utf8' },
)
if ((cleanTree.status ?? 1) !== 0) {
  console.error('Could not verify the Git worktree before live calibration.')
  process.exit(cleanTree.status ?? 1)
}
if (cleanTree.stdout.trim()) {
  console.error('Evidence calibration requires a clean Git worktree before any live model call.')
  console.error('Commit the exact corpus and harness first so the artifact SHA and digests are reproducible.')
  process.exit(1)
}

const expectedModel = process.env[EXPECTED_MODEL_ENV]?.trim()
const expectedProvider = process.env[EXPECTED_PROVIDER_ENV]?.trim()
if (!expectedModel || !expectedProvider) {
  console.error(`${EXPECTED_MODEL_ENV} and ${EXPECTED_PROVIDER_ENV} are required — name the slot contract you intend to calibrate.`)
  console.error('This prevents a stale CMS/default slot from producing a misleading passing artifact.')
  process.exit(1)
}

if (!process.env.MONGODB_URI) {
  console.error('MONGODB_URI is required — calibration must verify the authoritative CMS ModelConfig, not a silent code default.')
  process.exit(1)
}

if (!PROVIDER_KEYS.some((key) => process.env[key])) {
  console.error(`Need at least one provider key (${PROVIDER_KEYS.join(' | ')}) before running live calibration.`)
  process.exit(1)
}

const result = spawnSync(
  'npx',
  ['vitest', 'run', 'scripts/eval/jobsEvidenceGoldenSet.test.ts'],
  {
    stdio: 'inherit',
    env: { ...process.env, JOBS_EVIDENCE_EVAL: '1' },
  },
)
process.exit(result.status ?? 1)
