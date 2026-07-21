#!/usr/bin/env tsx
/**
 * Non-dropping deployment gate for the Jobs purgeAt TTL index.
 *
 * Inspect only:
 *   npm run prepare:jobs-retention-index
 * Create when missing:
 *   npm run prepare:jobs-retention-index -- --apply
 * Promotion check (non-zero when absent/incompatible):
 *   npm run check:jobs-retention-index
 */

import { pathToFileURL } from 'node:url'
import { connectDB } from '../shared/db/connection'
import {
  assertRetentionTtlIndex,
  prepareRetentionTtlIndex,
} from '../modules/jobs/services/retentionIndex'

export type RetentionIndexMode = 'dry-run' | 'apply' | 'check'

export function retentionIndexModeOf(argv: string[]): RetentionIndexMode {
  const supported = new Set(['--apply', '--check'])
  const unknown = argv.filter((argument) => !supported.has(argument))
  if (unknown.length) {
    throw new Error(`unknown argument${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`)
  }
  const apply = argv.includes('--apply')
  const check = argv.includes('--check')
  if (apply && check) throw new Error('choose either --apply or --check, not both')
  return apply ? 'apply' : check ? 'check' : 'dry-run'
}

export async function runRetentionIndexPreparation(argv: string[]): Promise<void> {
  const mode = retentionIndexModeOf(argv)
  await connectDB({ schemaInitialization: 'disabled' })
  const status = await prepareRetentionTtlIndex(mode === 'apply')
  if (mode === 'check') assertRetentionTtlIndex(status.keyIdentical)

  console.log('\nJobs retention TTL index')
  console.log('────────────────────────')
  console.log(`State: ${status.ready ? 'READY' : 'MISSING'}`)
  console.log(`Index: ${status.matchingName ?? 'none'}`)
  if (status.purgeAtRows !== undefined) {
    console.log(`Rows carrying purgeAt before index activation: ${status.purgeAtRows}`)
  }
  if (mode === 'dry-run' && !status.ready) {
    if ((status.purgeAtRows ?? 0) > 0) {
      console.log(
        'DRY RUN — run repair:jobs-retention -- --apply, verify zero rows, then create the index.',
      )
    } else {
      console.log('DRY RUN — re-run with --apply to create the missing index.')
    }
  }
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  runRetentionIndexPreparation(process.argv.slice(2))
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Jobs retention TTL index preparation failed:', error)
      process.exit(1)
    })
}
