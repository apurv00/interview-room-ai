#!/usr/bin/env tsx
/** Read-only A12 discovery-quality report. Emits JSON to stdout only. */

import mongoose from 'mongoose'
import { connectDB } from '../shared/db/connection'
import { readDiscoveryQualityReport } from '../modules/jobs/services/discoveryQualityReport'

interface ReportArguments {
  samplePerSource: number
}

export function parseReportArguments(argv: readonly string[]): ReportArguments {
  let samplePerSource = 5
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    const [name, inlineValue] = argument.split('=', 2)
    if (name === '--sample-per-source') {
      const value = inlineValue ?? argv[++index]
      if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
      samplePerSource = Number(value)
      if (!Number.isSafeInteger(samplePerSource) || samplePerSource < 1 || samplePerSource > 50) {
        throw new Error('--sample-per-source must be an integer from 1 to 50')
      }
      continue
    }
    throw new Error(`Unknown argument: ${argument}`)
  }
  return { samplePerSource }
}

async function main(): Promise<void> {
  const { samplePerSource } = parseReportArguments(process.argv.slice(2))
  await connectDB({ schemaInitialization: 'disabled' })
  try {
    // This is a current-state report over a 7-day creation cohort, never an
    // unsupported historical "as-of" reconstruction.
    const report = await readDiscoveryQualityReport(new Date(), { samplePerSource })
    console.log(JSON.stringify(report, null, 2))
  } finally {
    await mongoose.disconnect().catch(() => undefined)
  }
}

main().catch((error) => {
  console.error('Jobs discovery-quality report failed:', error)
  process.exitCode = 1
})
