#!/usr/bin/env npx tsx
/**
 * Loads benchmark case fixtures from modules/cms/__fixtures__/benchmarkCases
 * into MongoDB. Idempotent — uses upsert keyed on caseId.
 *
 * Usage:
 *   MONGODB_URI="mongodb+srv://..." npx tsx scripts/loadBenchmarkFixtures.ts
 */

import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { connectDB } from '../shared/db/connection'
import { BenchmarkCase } from '../shared/db/models/BenchmarkCase'

const FIXTURES_DIR = join(__dirname, '..', 'modules', 'cms', '__fixtures__', 'benchmarkCases')

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is required')
    process.exit(1)
  }

  await connectDB()

  const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json'))
  console.log(`Found ${files.length} fixtures in ${FIXTURES_DIR}`)

  let upserted = 0
  for (const file of files) {
    const raw = readFileSync(join(FIXTURES_DIR, file), 'utf-8')
    const data = JSON.parse(raw)
    if (!data.caseId) {
      console.warn(`Skipping ${file}: missing caseId`)
      continue
    }
    await BenchmarkCase.findOneAndUpdate(
      { caseId: data.caseId },
      { $set: data },
      { upsert: true, new: true }
    )
    console.log(`  ✓ ${data.caseId}`)
    upserted++
  }

  console.log(`\nUpserted ${upserted} benchmark cases.`)
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
