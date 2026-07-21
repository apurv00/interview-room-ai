#!/usr/bin/env tsx
/**
 * Operator entry point for the canonical A04 lifecycle policy.
 *
 * Dry-run by default:
 *   npm run sweep:jobs-retention
 *   npm run sweep:jobs-retention -- --apply
 */

import { pathToFileURL } from 'node:url'
import {
  runJobsRetentionSweep,
  type JobsRetentionSweepReport,
} from '../modules/jobs/services/retentionService'

export type RetentionSweepMode = 'dry-run' | 'apply' | 'check'

export function retentionSweepModeOf(argv: string[]): RetentionSweepMode {
  const supportedArguments = new Set(['--apply', '--check'])
  const unknownArguments = argv.filter((argument) => !supportedArguments.has(argument))
  if (unknownArguments.length) {
    throw new Error(
      `unknown argument${unknownArguments.length === 1 ? '' : 's'}: ${unknownArguments.join(', ')}`,
    )
  }
  const apply = argv.includes('--apply')
  const check = argv.includes('--check')
  if (apply && check) throw new Error('choose either --apply or --check, not both')
  return apply ? 'apply' : check ? 'check' : 'dry-run'
}

export function assertRetentionSweepConverged(report: JobsRetentionSweepReport): void {
  const pending = [
    ['owner contradictions', report.ownerPins.contradictions],
    ['freshness backfills', report.freshness.missingCanonicalFreshness],
    ['valid-through closures', report.closures.validThroughEligible],
    ['aged-out closures', report.closures.agedOutEligible],
    ['tombstones to slim', report.tombstones.eligibleToSlim],
    ['stale TTL rows to clear', report.ttl.staleNonPurgeable],
    ['normal archives to schedule', report.ttl.normalArchivesEligible],
  ] as const
  const outstanding = pending.filter(([, count]) => count > 0)
  if (outstanding.length > 0) {
    throw new Error(
      `Jobs retention sweep is not converged: ${outstanding
        .map(([label, count]) => `${label}=${count}`)
        .join(', ')}`,
    )
  }
}

export async function runRetentionSweepCli(argv: string[]): Promise<void> {
  const mode = retentionSweepModeOf(argv)
  const report = await runJobsRetentionSweep({
    dryRun: mode !== 'apply',
    schemaInitialization: 'disabled',
  })
  console.log(JSON.stringify(report, null, 2))
  if (mode === 'check') {
    assertRetentionSweepConverged(report)
    console.log('\nCHECK PASSED — no pending Jobs lifecycle mutations remain.')
  } else if (mode === 'dry-run') {
    console.log('\nDRY RUN — no writes performed. Re-run with --apply to execute the same policy now.')
  }
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  runRetentionSweepCli(process.argv.slice(2))
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Jobs retention sweep failed:', error)
      process.exit(1)
    })
}
