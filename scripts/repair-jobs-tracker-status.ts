#!/usr/bin/env tsx
/**
 * Repairs the historical A06 contradiction created by the former tracker
 * GET path: an unconfirmed apply-link click could be system-transitioned to
 * `ghosted` and displayed as "No response". The predicate is intentionally
 * narrow: no Date-valued appliedAt, current ghosted state, and the latest
 * two audit entries are system apply_clicked -> system ghosted.
 *
 * Dry-run by default:
 *   npm run repair:jobs-tracker-status
 *   npm run repair:jobs-tracker-status -- --apply
 *   npm run check:jobs-tracker-status
 */

import { pathToFileURL } from 'node:url'
import type { Types } from 'mongoose'
import { connectDB } from '../shared/db/connection'
import { JobApplication } from '../shared/db/models'
import {
  JobsAccountInactiveError,
  withActiveJobsAccountWrite,
} from '../shared/services/jobsAccountFence'

const BATCH_SIZE = 100

export type TrackerStatusRepairMode = 'dry-run' | 'apply' | 'check'

export function trackerStatusRepairModeOf(argv: string[]): TrackerStatusRepairMode {
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

export function invalidUnconfirmedGhostFilter(): Record<string, unknown> {
  return {
    status: 'ghosted',
    appliedAt: { $not: { $type: 'date' } },
    $expr: {
      $and: [
        { $eq: [{ $arrayElemAt: ['$statusHistory.status', -1] }, 'ghosted'] },
        { $eq: [{ $arrayElemAt: ['$statusHistory.source', -1] }, 'system'] },
        { $eq: [{ $arrayElemAt: ['$statusHistory.status', -2] }, 'apply_clicked'] },
        { $eq: [{ $arrayElemAt: ['$statusHistory.source', -2] }, 'system'] },
      ],
    },
  }
}

export function assertTrackerStatusInvariant(invalidUnconfirmedGhosts: number): void {
  if (invalidUnconfirmedGhosts > 0) {
    throw new Error(`tracker status invariant failed: unconfirmed system-ghosted rows=${invalidUnconfirmedGhosts}`)
  }
}

interface RepairCandidate {
  _id: Types.ObjectId
  userId: Types.ObjectId
  updatedAt: Date
}

function groupByUser(candidates: RepairCandidate[]): Map<string, RepairCandidate[]> {
  const grouped = new Map<string, RepairCandidate[]>()
  for (const candidate of candidates) {
    const userId = String(candidate.userId)
    grouped.set(userId, [...(grouped.get(userId) ?? []), candidate])
  }
  return grouped
}

export async function runTrackerStatusRepair(argv: string[], now = new Date()): Promise<void> {
  const mode = trackerStatusRepairModeOf(argv)
  await connectDB({ schemaInitialization: 'disabled' })

  const filter = invalidUnconfirmedGhostFilter()
  const before = await JobApplication.countDocuments(filter)
  console.log('\nJobs tracker-status repair')
  console.log('──────────────────────────')
  console.log(`Unconfirmed rows incorrectly shown as No response: ${before}`)

  if (mode === 'check') {
    assertTrackerStatusInvariant(before)
    console.log('\nCHECK PASSED — no unconfirmed click is system-ghosted.')
    return
  }
  if (mode === 'dry-run') {
    console.log('\nDRY RUN — no writes performed. Re-run with --apply to repair.')
    return
  }

  let cursor: Types.ObjectId | undefined
  let repaired = 0
  let inactiveAccounts = 0
  while (true) {
    const pageFilter = cursor ? { $and: [filter, { _id: { $gt: cursor } }] } : filter
    const candidates = await JobApplication.find(pageFilter)
      .select('_id userId updatedAt')
      .sort({ _id: 1 })
      .limit(BATCH_SIZE)
      .lean() as RepairCandidate[]
    if (candidates.length === 0) break
    cursor = candidates[candidates.length - 1]._id

    for (const [userId, rows] of Array.from(groupByUser(candidates).entries())) {
      try {
        const result = await withActiveJobsAccountWrite(userId, (session) =>
          JobApplication.bulkWrite(
            rows.map((row) => ({
              updateOne: {
                filter: {
                  _id: row._id,
                  userId: row.userId,
                  updatedAt: row.updatedAt,
                  ...invalidUnconfirmedGhostFilter(),
                },
                update: {
                  $set: { status: 'apply_clicked' },
                  $unset: { ghostSuggestedAt: 1 },
                  $push: {
                    statusHistory: { status: 'apply_clicked', at: now, source: 'system' },
                  },
                },
              },
            })),
            { session },
          ),
        )
        repaired += result.modifiedCount ?? 0
      } catch (error) {
        if (error instanceof JobsAccountInactiveError) {
          inactiveAccounts += 1
          continue
        }
        throw error
      }
    }
  }

  console.log(`\nRows repaired: ${repaired}`)
  console.log(`Accounts already deleting/deleted: ${inactiveAccounts}`)
  const remaining = await JobApplication.countDocuments(invalidUnconfirmedGhostFilter())
  assertTrackerStatusInvariant(remaining)
  console.log('Verified: every historical unconfirmed system-ghost is corrected with an audit entry.')
}

async function main() {
  await runTrackerStatusRepair(process.argv.slice(2))
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Jobs tracker-status repair failed:', error)
      process.exit(1)
    })
}
