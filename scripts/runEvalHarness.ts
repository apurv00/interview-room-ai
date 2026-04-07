#!/usr/bin/env npx tsx
/**
 * Scoring consistency harness.
 *
 * Runs each active BenchmarkCase N times through evaluateStructured() and
 * writes a Markdown report measuring per-dimension variance, overall score
 * variance, and tag stability.
 *
 * Exit code is non-zero if the worst per-dimension std dev exceeds the
 * configured threshold.
 *
 * Usage:
 *   MONGODB_URI="mongodb+srv://..." ANTHROPIC_API_KEY="..." \
 *     npx tsx scripts/runEvalHarness.ts [--runs 5] [--temperature 0] [--threshold 8]
 */

import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  runConsistencyCheck,
  formatConsistencyReportMarkdown,
} from '../modules/cms/services/benchmarkService'

function parseArgs() {
  const args = process.argv.slice(2)
  const out: { runs: number; temperature?: number; threshold: number } = {
    runs: 5,
    threshold: 8,
  }
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    const next = args[i + 1]
    if (flag === '--runs' && next) {
      out.runs = parseInt(next, 10)
      i++
    } else if (flag === '--temperature' && next) {
      out.temperature = parseFloat(next)
      i++
    } else if (flag === '--threshold' && next) {
      out.threshold = parseFloat(next)
      i++
    }
  }
  return out
}

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is required')
    process.exit(1)
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is required')
    process.exit(1)
  }

  const { runs, temperature, threshold } = parseArgs()

  console.log(
    `Running consistency harness: runs=${runs}, temperature=${temperature ?? '(default)'}, threshold=${threshold}`
  )

  const report = await runConsistencyCheck({ runs, temperature })

  const outDir = join(process.cwd(), 'tmp')
  mkdirSync(outDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = join(outDir, `eval-report-${stamp}.md`)
  writeFileSync(outPath, formatConsistencyReportMarkdown(report))

  console.log(`\nReport written to ${outPath}`)
  console.log(`Mean dimension std dev: ${report.meanStdDev.toFixed(2)}`)
  console.log(`Worst dimension std dev: ${report.worstStdDev.toFixed(2)}`)

  if (report.worstStdDev > threshold) {
    console.error(
      `\n❌ Worst std dev ${report.worstStdDev.toFixed(2)} exceeds threshold ${threshold}`
    )
    process.exit(1)
  }

  console.log(`\n✓ Within threshold (${threshold})`)
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
