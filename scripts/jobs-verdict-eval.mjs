#!/usr/bin/env node
/**
 * Golden-set live eval runner (INGESTION §4.5 rollout gate; ruling #8
 * epoch-replay discipline). Thin wrapper: sets the env gate and runs the
 * vitest harness, which exercises the REAL prompt + schema + evaluator
 * against modules/jobs/eval/goldenSet.json with live model calls.
 *
 *   OPENAI_API_KEY=... node scripts/jobs-verdict-eval.mjs
 *
 * Gates: fraud-FP on labeled-genuine <2%, evaluator errors <5%.
 * Artifact: modules/jobs/eval/results/<epoch>-<ts>.json — keep the passing
 * artifact of the CURRENT epoch; a model/prompt cutover requires a fresh
 * run compared against it before enforcement continues on the new epoch.
 *
 * Cost: ~130 fixtures ≈ $0.40-0.80 per run at gpt-5.6-luna pricing.
 */
import { spawnSync } from 'node:child_process'

if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
  console.error('Need OPENAI_API_KEY (slot default is an OpenAI model) — aborting before a 130-fixture run of silent failures.')
  process.exit(1)
}

const r = spawnSync('npx', ['vitest', 'run', 'modules/jobs/eval/verdictGoldenSet.test.ts'], {
  stdio: 'inherit',
  env: { ...process.env, JOBS_VERDICT_EVAL: '1' },
})
process.exit(r.status ?? 1)
