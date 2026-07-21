#!/usr/bin/env tsx
/**
 * Idempotent repair for the Jobs ownership/TTL invariant.
 *
 * Historical close writers could stamp `purgeAt` from a stale
 * `userReferenced:false` snapshot while Save/Apply/Tailor concurrently
 * created a JobApplication. That leaves an owner-linked posting eligible
 * for TTL deletion. This migration makes every application-owned posting a
 * permanent retention pin and clears TTL from every already-pinned row.
 *
 * Dry-run by default:
 *   npm run repair:jobs-retention
 *   npm run repair:jobs-retention -- --apply
 *   npm run check:jobs-retention     # read-only deploy gate; non-zero on drift
 */

import { pathToFileURL } from 'node:url'
import { connectDB } from '../shared/db/connection'
import { JobApplication, JobPosting } from '../shared/db/models'

const BATCH_SIZE = 500

export interface RetentionInvariantCounts {
  ownerContradictions: number
  pinnedWithTtl: number
}

export type RetentionRepairMode = 'dry-run' | 'apply' | 'check'

export function retentionRepairModeOf(argv: string[]): RetentionRepairMode {
  const supportedArguments = new Set(['--apply', '--check'])
  const unknownArguments = argv.filter((argument) => !supportedArguments.has(argument))
  if (unknownArguments.length) {
    throw new Error(`unknown argument${unknownArguments.length === 1 ? '' : 's'}: ${unknownArguments.join(', ')}`)
  }

  const apply = argv.includes('--apply')
  const check = argv.includes('--check')
  if (apply && check) throw new Error('choose either --apply or --check, not both')
  return apply ? 'apply' : check ? 'check' : 'dry-run'
}

export function assertRetentionInvariant({
  ownerContradictions,
  pinnedWithTtl,
}: RetentionInvariantCounts): void {
  if (ownerContradictions || pinnedWithTtl) {
    throw new Error(
      `retention invariant failed: owner contradictions=${ownerContradictions}, pinned TTL rows=${pinnedWithTtl}`,
    )
  }
}

export async function runRetentionRepair(argv: string[]): Promise<void> {
  const mode = retentionRepairModeOf(argv)
  // Dry-run/check must be physically read-only with respect to schema. Apply
  // uses explicit updates and likewise must not mask a missing deploy index.
  await connectDB({ schemaInitialization: 'disabled' })

  const ownedIds = (await JobApplication.distinct('jobPostingId')).filter(Boolean)
  const existingOwnedRows = ownedIds.length
    ? await JobPosting.countDocuments({ _id: { $in: ownedIds } })
    : 0
  const missingOwnedRows = ownedIds.length - existingOwnedRows
  const ownerContradictions = ownedIds.length
    ? await JobPosting.countDocuments({
        _id: { $in: ownedIds },
        $or: [
          { userReferenced: { $ne: true } },
          { purgeAt: { $exists: true } },
        ],
      })
    : 0
  const pinnedWithTtl = await JobPosting.countDocuments({
    userReferenced: true,
    purgeAt: { $exists: true },
  })

  console.log('\nJobs retention repair')
  console.log('─────────────────────')
  console.log(`Application-owned posting ids: ${ownedIds.length}`)
  console.log(`Already missing posting rows (snapshot-only; not repairable): ${missingOwnedRows}`)
  console.log(`Owner rows with a broken pin/TTL invariant: ${ownerContradictions}`)
  console.log(`All pinned rows still carrying purgeAt: ${pinnedWithTtl}`)

  if (mode === 'check') {
    assertRetentionInvariant({ ownerContradictions, pinnedWithTtl })
    console.log('\nCHECK PASSED — every retained owner row is pinned and has no TTL.')
    return
  }

  if (mode === 'dry-run') {
    console.log('\nDRY RUN — no writes performed. Re-run with --apply to repair.')
    return
  }

  let matched = 0
  let modified = 0
  for (let i = 0; i < ownedIds.length; i += BATCH_SIZE) {
    const result = await JobPosting.updateMany(
      { _id: { $in: ownedIds.slice(i, i + BATCH_SIZE) } },
      { $set: { userReferenced: true }, $unset: { purgeAt: 1 } },
    )
    matched += result.matchedCount ?? 0
    modified += result.modifiedCount ?? 0
  }
  const pinnedRepair = await JobPosting.updateMany(
    { userReferenced: true, purgeAt: { $exists: true } },
    { $unset: { purgeAt: 1 } },
  )

  console.log(`\nOwned rows matched: ${matched}`)
  console.log(`Owned rows modified: ${modified}`)
  console.log(`Additional pinned TTL rows modified: ${pinnedRepair.modifiedCount ?? 0}`)

  // Re-read ownership after the writes. Old application writers may still be
  // draining while the migration runs, so verification must not reuse the
  // pre-repair snapshot.
  const verifiedOwnedIds = (await JobApplication.distinct('jobPostingId')).filter(Boolean)
  const remainingOwners = verifiedOwnedIds.length
    ? await JobPosting.countDocuments({
        _id: { $in: verifiedOwnedIds },
        $or: [
          { userReferenced: { $ne: true } },
          { purgeAt: { $exists: true } },
        ],
      })
    : 0
  const remainingPinnedTtl = await JobPosting.countDocuments({
    userReferenced: true,
    purgeAt: { $exists: true },
  })
  assertRetentionInvariant({
    ownerContradictions: remainingOwners,
    pinnedWithTtl: remainingPinnedTtl,
  })
  console.log('\nVerified: every retained owner row is pinned and has no TTL.')
}

async function main() {
  await runRetentionRepair(process.argv.slice(2))
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Jobs retention repair failed:', error)
      process.exit(1)
    })
}
