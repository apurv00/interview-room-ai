#!/usr/bin/env tsx
/**
 * Non-dropping rollout gate for the global A06 tracker-status due-work index.
 *
 *   npm run prepare:jobs-tracker-status-index            # local plan only
 *   npm run prepare:jobs-tracker-status-index -- --apply # create + verify
 *   npm run check:jobs-tracker-status-index              # read-only gate
 */

import { pathToFileURL } from 'node:url'
import { connectDB } from '../shared/db/connection'
import { JobApplication } from '../shared/db/models'
import {
  assertTrackerStatusSweepIndex,
  isExactTrackerStatusSweepIndex,
  TRACKER_STATUS_SWEEP_INDEX_KEY,
  TRACKER_STATUS_SWEEP_INDEX_NAME,
  TRACKER_STATUS_SWEEP_INDEX_PARTIAL,
} from '../modules/jobs/services/trackerStatusSweepService'

export type TrackerStatusIndexMode = 'plan' | 'apply' | 'check'

export function trackerStatusIndexModeOf(argv: string[]): TrackerStatusIndexMode {
  const supportedArguments = new Set(['--apply', '--check'])
  const unknownArguments = argv.filter((argument) => !supportedArguments.has(argument))
  if (unknownArguments.length) {
    throw new Error(`unknown argument${unknownArguments.length === 1 ? '' : 's'}: ${unknownArguments.join(', ')}`)
  }
  const apply = argv.includes('--apply')
  const check = argv.includes('--check')
  if (apply && check) throw new Error('choose either --apply or --check, not both')
  return apply ? 'apply' : check ? 'check' : 'plan'
}

function sameIndexKey(index: { key?: Record<string, unknown> }): boolean {
  const key = index.key ?? {}
  const expected = TRACKER_STATUS_SWEEP_INDEX_KEY
  return Object.keys(key).length === Object.keys(expected).length &&
    Object.entries(expected).every(([field, direction]) => key[field] === direction)
}

export async function runTrackerStatusIndexPreparation(argv: string[]): Promise<void> {
  const mode = trackerStatusIndexModeOf(argv)
  console.log('\nJobs tracker-status index plan')
  console.log('──────────────────────────────')
  console.log(`Name: ${TRACKER_STATUS_SWEEP_INDEX_NAME}`)
  console.log(`Key: ${JSON.stringify(TRACKER_STATUS_SWEEP_INDEX_KEY)}`)
  console.log(`Partial: ${JSON.stringify(TRACKER_STATUS_SWEEP_INDEX_PARTIAL)}`)

  if (mode === 'plan') {
    console.log('\nPLAN ONLY — no database connection or write. Re-run with --apply.')
    return
  }

  await connectDB({ schemaInitialization: 'disabled' })
  let indexes = await JobApplication.collection.indexes()
  if (mode === 'check') {
    assertTrackerStatusSweepIndex(indexes)
    console.log('\nCHECK PASSED — exact tracker-status due-work index exists.')
    return
  }

  const incompatible = indexes.find((index) =>
    (index.name === TRACKER_STATUS_SWEEP_INDEX_NAME || sameIndexKey(index)) &&
    !isExactTrackerStatusSweepIndex(index),
  )
  if (incompatible) {
    throw new Error(
      `incompatible tracker-status index ${incompatible.name ?? '<unnamed>'}; explicit operator repair required`,
    )
  }

  if (!indexes.some(isExactTrackerStatusSweepIndex)) {
    await JobApplication.collection.createIndex(
      TRACKER_STATUS_SWEEP_INDEX_KEY,
      {
        name: TRACKER_STATUS_SWEEP_INDEX_NAME,
        partialFilterExpression: TRACKER_STATUS_SWEEP_INDEX_PARTIAL,
      },
    )
  }
  indexes = await JobApplication.collection.indexes()
  assertTrackerStatusSweepIndex(indexes)
  console.log('\nVerified: exact tracker-status due-work index exists; no index was removed.')
}

async function main() {
  await runTrackerStatusIndexPreparation(process.argv.slice(2))
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Jobs tracker-status index preparation failed:', error)
      process.exit(1)
    })
}
