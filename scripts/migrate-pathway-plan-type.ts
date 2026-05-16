#!/usr/bin/env npx tsx
/**
 * Idempotent backfill for the `planType` field on PathwayPlan documents.
 *
 * Why:
 * Before the 2026-05-14 pathway redesign (commit 3a9a9e7), PathwayPlan
 * documents didn't carry a `planType` field at all. After the redesign,
 * `getCurrentPathway()` started filtering on `planType: 'standard'`, so
 * every pre-redesign document silently became invisible — the Pathway
 * page showed "NO PATHWAY YET" even when a fully-populated plan
 * existed for the user.
 *
 * The read-side fix in `pathwayPlanner.ts` (STANDARD_OR_LEGACY_FILTER)
 * makes those docs visible immediately. This migration backfills the
 * actual field so the OR filter can eventually simplify back to a
 * strict `planType: 'standard'` match.
 *
 * Safety:
 * - Idempotent. Running twice is a no-op (matches only docs WITHOUT planType).
 * - Targets only docs missing the field. Does NOT touch 'monthly' or
 *   'universal' docs.
 * - Dry-run by default. Pass --apply to actually write.
 *
 * Usage:
 *   MONGODB_URI="mongodb+srv://..." npx tsx scripts/migrate-pathway-plan-type.ts        # dry-run (default)
 *   MONGODB_URI="mongodb+srv://..." npx tsx scripts/migrate-pathway-plan-type.ts --apply
 *
 * Or with a .env.local:
 *   npx tsx -r dotenv/config scripts/migrate-pathway-plan-type.ts --apply
 */

import { connectDB } from '../shared/db/connection'
import { PathwayPlan } from '../shared/db/models'

const STANDARD = 'standard'

async function main() {
  const apply = process.argv.includes('--apply')

  await connectDB()

  // Match docs where the field doesn't exist at all OR is null.
  // Do NOT match docs already set to 'monthly' or 'universal' — those
  // are different planning systems and shouldn't be coerced.
  const filter = {
    $or: [
      { planType: { $exists: false } },
      { planType: null },
    ],
  }

  const matchedCount = await PathwayPlan.countDocuments(filter)

  console.log(`\nPathwayPlan backfill — planType → '${STANDARD}'`)
  console.log('────────────────────────────────────────────')
  console.log(`Documents matching backfill filter: ${matchedCount}`)

  if (matchedCount === 0) {
    console.log('\nNo documents need backfilling. Exiting.')
    process.exit(0)
  }

  if (!apply) {
    console.log('\nDRY RUN — no writes performed.')
    console.log('Re-run with --apply to actually backfill.')
    // Sample a few docs so the operator can sanity-check.
    const samples = await PathwayPlan.find(filter)
      .limit(3)
      .select('_id userId generatedAt')
      .lean()
    if (samples.length > 0) {
      console.log('\nSample matching docs:')
      for (const s of samples) {
        console.log(`  _id=${s._id} userId=${s.userId} generatedAt=${(s as { generatedAt?: Date }).generatedAt}`)
      }
    }
    process.exit(0)
  }

  const result = await PathwayPlan.updateMany(filter, { $set: { planType: STANDARD } })

  console.log(`\nMatched: ${result.matchedCount}`)
  console.log(`Modified: ${result.modifiedCount}`)
  console.log('Done.')

  // Verify — re-count after the update. Should be 0.
  const remaining = await PathwayPlan.countDocuments(filter)
  if (remaining !== 0) {
    console.warn(`\n⚠️  ${remaining} doc(s) still match the filter after update — investigate.`)
    process.exit(1)
  }
  console.log(`\nVerified: 0 documents now match the backfill filter.`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Migration failed:', err)
    process.exit(1)
  })
