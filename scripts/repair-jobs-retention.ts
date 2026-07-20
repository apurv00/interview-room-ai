#!/usr/bin/env npx tsx
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
 */

import { connectDB } from '../shared/db/connection'
import { JobApplication, JobPosting } from '../shared/db/models'

const BATCH_SIZE = 500

async function main() {
  const apply = process.argv.includes('--apply')
  await connectDB()

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

  if (!apply) {
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

  const remainingOwners = ownedIds.length
    ? await JobPosting.countDocuments({
        _id: { $in: ownedIds },
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
  if (remainingOwners || remainingPinnedTtl) {
    throw new Error(`repair incomplete: owner contradictions=${remainingOwners}, pinned TTL rows=${remainingPinnedTtl}`)
  }
  console.log('\nVerified: every retained owner row is pinned and has no TTL.')
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Jobs retention repair failed:', error)
    process.exit(1)
  })
