#!/usr/bin/env tsx
/**
 * Idempotent A02 migration for durable source lineage.
 *
 * Detailed provenance is intentionally capped at eight entries, so it cannot
 * also be the permanent legal lookup. This migration copies every currently
 * known provenance source into the non-evicting `sourceIds` array. Legacy rows
 * with no provenance or a cap-reached array receive an unknown-lineage
 * sentinel; a future revoke then restricts them conservatively.
 *
 * Dry-run by default:
 *   npm run repair:jobs-source-lineage
 *   npm run repair:jobs-source-lineage -- --apply
 *   npm run check:jobs-source-lineage
 */

import { pathToFileURL } from 'node:url'
import { connectDB } from '../shared/db/connection'
import {
  JOB_SOURCE_CONTROL_META_ID,
  JOB_SOURCE_ID_PATTERN,
  JOB_SOURCE_LINEAGE_UNKNOWN,
  JobPosting,
  JobSourceControlMeta,
} from '../shared/db/models'

export type SourceLineageRepairMode = 'dry-run' | 'apply' | 'check'

export interface SourceLineageInvariantCounts {
  missingOrEmptySourceIds: number
  invalidProvenanceSourceIds: number
  provenanceCoverageGaps: number
  globalMarkerMissing: number
}

export function sourceLineageRepairModeOf(argv: string[]): SourceLineageRepairMode {
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

function safeArrayExpression(fieldReference: string): Record<string, unknown> {
  return { $cond: [{ $isArray: fieldReference }, fieldReference, []] }
}

function canonicalSourceIdExpression(valueReference: string): Record<string, unknown> {
  return {
    $cond: [
      { $eq: [{ $type: valueReference }, 'string'] },
      { $regexMatch: { input: valueReference, regex: JOB_SOURCE_ID_PATTERN.source } },
      false,
    ],
  }
}

function validCurrentSourceIdsExpression(): Record<string, unknown> {
  return {
    $filter: {
      input: safeArrayExpression('$sourceIds'),
      as: 'sourceId',
      cond: canonicalSourceIdExpression('$$sourceId'),
    },
  }
}

function validProvenanceSourceIdsExpression(): Record<string, unknown> {
  return {
    $map: {
      input: {
        $filter: {
          input: safeArrayExpression('$provenance'),
          as: 'entry',
          cond: canonicalSourceIdExpression('$$entry.sourceId'),
        },
      },
      as: 'entry',
      in: '$$entry.sourceId',
    },
  }
}

function validSourceIdsArrayExpression(): Record<string, unknown> {
  const safeSourceIds = safeArrayExpression('$sourceIds')
  return {
    $and: [
      { $isArray: '$sourceIds' },
      { $gt: [{ $size: safeSourceIds }, 0] },
      {
        $allElementsTrue: [{
          $map: {
            input: safeSourceIds,
            as: 'sourceId',
            in: canonicalSourceIdExpression('$$sourceId'),
          },
        }],
      },
    ],
  }
}

function hasInvalidCurrentSourceIdExpression(): Record<string, unknown> {
  return {
    $or: [
      {
        $and: [
          { $ne: [{ $type: '$sourceIds' }, 'missing'] },
          { $eq: [{ $isArray: '$sourceIds' }, false] },
        ],
      },
      {
        $anyElementTrue: [{
          $map: {
            input: safeArrayExpression('$sourceIds'),
            as: 'sourceId',
            in: { $not: [canonicalSourceIdExpression('$$sourceId')] },
          },
        }],
      },
    ],
  }
}

function hasInvalidProvenanceSourceIdExpression(): Record<string, unknown> {
  return {
    $or: [
      {
        $and: [
          { $ne: [{ $type: '$provenance' }, 'missing'] },
          { $eq: [{ $isArray: '$provenance' }, false] },
        ],
      },
      {
        $anyElementTrue: [{
          $map: {
            input: safeArrayExpression('$provenance'),
            as: 'entry',
            in: { $not: [canonicalSourceIdExpression('$$entry.sourceId')] },
          },
        }],
      },
    ],
  }
}

function missingOrEmptySourceIdsFilter(): Record<string, unknown> {
  return {
    $expr: { $not: [validSourceIdsArrayExpression()] },
  }
}

function provenanceCoverageGapExpression(): Record<string, unknown> {
  return {
    $gt: [
      {
        $size: {
          $setDifference: [
            validProvenanceSourceIdsExpression(),
            validCurrentSourceIdsExpression(),
          ],
        },
      },
      0,
    ],
  }
}

function lineageRepairFilter(): Record<string, unknown> {
  return {
    $or: [
      missingOrEmptySourceIdsFilter(),
      { $expr: hasInvalidProvenanceSourceIdExpression() },
      { $expr: provenanceCoverageGapExpression() },
    ],
  }
}

async function invariantCounts(): Promise<SourceLineageInvariantCounts> {
  const [
    missingOrEmptySourceIds,
    invalidProvenanceSourceIds,
    provenanceCoverage,
    globalMarker,
  ] = await Promise.all([
    JobPosting.countDocuments(missingOrEmptySourceIdsFilter()),
    JobPosting.countDocuments({ $expr: hasInvalidProvenanceSourceIdExpression() }),
    JobPosting.aggregate<{ count: number }>([
      {
        $match: {
          $expr: provenanceCoverageGapExpression(),
        },
      },
      { $count: 'count' },
    ]),
    JobSourceControlMeta.exists({ _id: JOB_SOURCE_CONTROL_META_ID, sourceLineageVersion: 1 }),
  ])

  return {
    missingOrEmptySourceIds,
    invalidProvenanceSourceIds,
    provenanceCoverageGaps: provenanceCoverage[0]?.count ?? 0,
    globalMarkerMissing: globalMarker ? 0 : 1,
  }
}

export function assertSourceLineageInvariant(counts: SourceLineageInvariantCounts): void {
  if (
    counts.missingOrEmptySourceIds ||
    counts.invalidProvenanceSourceIds ||
    counts.provenanceCoverageGaps ||
    counts.globalMarkerMissing
  ) {
    throw new Error(
      `source-lineage invariant failed: invalid sourceIds=${counts.missingOrEmptySourceIds}, invalid provenance=${counts.invalidProvenanceSourceIds}, provenance gaps=${counts.provenanceCoverageGaps}, global marker missing=${counts.globalMarkerMissing}`,
    )
  }
}

export async function runSourceLineageRepair(argv: string[]): Promise<void> {
  const mode = sourceLineageRepairModeOf(argv)
  // Even --apply performs only explicit writes. Never let a dry-run/check
  // auto-create collections or indexes and thereby mask a deploy defect.
  await connectDB({ schemaInitialization: 'disabled' })

  const before = await invariantCounts()
  const ambiguousLegacyRows = await JobPosting.countDocuments({
    $and: [
      lineageRepairFilter(),
      {
        $or: [
          { $expr: { $eq: [{ $size: validProvenanceSourceIdsExpression() }, 0] } },
          { $expr: hasInvalidCurrentSourceIdExpression() },
          { $expr: hasInvalidProvenanceSourceIdExpression() },
          { 'provenance.7': { $exists: true } },
        ],
      },
    ],
  })

  console.log('\nJobs source-lineage repair')
  console.log('──────────────────────────')
  console.log(`Rows with missing or invalid durable source IDs: ${before.missingOrEmptySourceIds}`)
  console.log(`Rows with invalid detailed provenance IDs: ${before.invalidProvenanceSourceIds}`)
  console.log(`Rows whose provenance is not covered: ${before.provenanceCoverageGaps}`)
  console.log(`Global lineage marker: ${before.globalMarkerMissing ? 'MISSING' : 'ready'}`)
  console.log(`Legacy rows requiring conservative unknown lineage: ${ambiguousLegacyRows}`)

  if (mode === 'check') {
    assertSourceLineageInvariant(before)
    console.log('\nCHECK PASSED — every posting has durable source lineage.')
    return
  }
  if (mode === 'dry-run') {
    console.log('\nDRY RUN — no writes performed. Re-run with --apply to repair.')
    return
  }

  const repair = await JobPosting.updateMany(
    lineageRepairFilter(),
    [{
      $set: {
        sourceIds: {
          $setUnion: [
            validCurrentSourceIdsExpression(),
            validProvenanceSourceIdsExpression(),
            {
              $cond: [
                {
                  $or: [
                    { $eq: [{ $size: validProvenanceSourceIdsExpression() }, 0] },
                    hasInvalidCurrentSourceIdExpression(),
                    hasInvalidProvenanceSourceIdExpression(),
                    { $gte: [{ $size: safeArrayExpression('$provenance') }, 8] },
                  ],
                },
                [JOB_SOURCE_LINEAGE_UNKNOWN],
                [],
              ],
            },
          ],
        },
        // Invalid detailed entries cannot survive the new Mongoose validator:
        // drop them while preserving every canonical ID in sourceIds. UNKNOWN
        // records that historical attribution was lossy.
        provenance: {
          $filter: {
            input: safeArrayExpression('$provenance'),
            as: 'entry',
            cond: canonicalSourceIdExpression('$$entry.sourceId'),
          },
        },
      },
    }],
  )
  console.log(`\nRows matched: ${repair.matchedCount ?? 0}`)
  console.log(`Rows modified: ${repair.modifiedCount ?? 0}`)

  // Never mark source control ready until the posting-level repair has been
  // re-read and proven complete. The control API requires this version.
  const postingVerification = await invariantCounts()
  if (
    postingVerification.missingOrEmptySourceIds ||
    postingVerification.invalidProvenanceSourceIds ||
    postingVerification.provenanceCoverageGaps
  ) {
    throw new Error(
      `source-lineage posting repair failed: invalid sourceIds=${postingVerification.missingOrEmptySourceIds}, invalid provenance=${postingVerification.invalidProvenanceSourceIds}, provenance gaps=${postingVerification.provenanceCoverageGaps}`,
    )
  }
  const [repairedPostings, unknownLineagePostings] = await Promise.all([
    JobPosting.countDocuments({}),
    JobPosting.countDocuments({ sourceIds: JOB_SOURCE_LINEAGE_UNKNOWN }),
  ])
  const repairedAt = new Date()
  const stampedMarker = await JobSourceControlMeta.findOneAndUpdate(
    { _id: JOB_SOURCE_CONTROL_META_ID },
    {
      $set: {
        sourceLineageVersion: 1,
        repairedAt,
        repairedPostings,
        retainedPostings: repairedPostings,
        unknownLineagePostings,
      },
      // `$max` initializes pre-admission markers without resetting a real
      // audit/ingest generation when this idempotent repair is rerun.
      $max: { controlWriteSeq: 0, ingestWriteSeq: 0 },
    },
    { upsert: true, new: true },
  )
  if (
    !stampedMarker ||
    !Number.isSafeInteger(stampedMarker.controlWriteSeq) ||
    !Number.isSafeInteger(stampedMarker.ingestWriteSeq) ||
    stampedMarker.controlWriteSeq < 0 ||
    stampedMarker.ingestWriteSeq < 0 ||
    stampedMarker.ingestWriteSeq >= Number.MAX_SAFE_INTEGER
  ) {
    throw new Error('global lineage marker has invalid source-control generations')
  }
  console.log('Global lineage marker stamped: version 1')

  const after = await invariantCounts()
  try {
    assertSourceLineageInvariant(after)
  } catch (error) {
    // A late pre-A02 writer can race the documented drain and create a gap
    // between posting verification and the config stamp. Revoke must remain
    // disabled in that state, so compensate by removing readiness without
    // deleting the permanent audit/admission generations. The exact CAS
    // prevents cleanup from invalidating a marker a concurrent fenced write
    // has already advanced.
    await JobSourceControlMeta.updateOne(
      {
        _id: JOB_SOURCE_CONTROL_META_ID,
        sourceLineageVersion: 1,
        controlWriteSeq: stampedMarker.controlWriteSeq,
        ingestWriteSeq: stampedMarker.ingestWriteSeq,
        repairedAt,
      },
      { $unset: { sourceLineageVersion: 1 } },
    )
    throw error
  }
  const unknownRows = await JobPosting.countDocuments({ sourceIds: JOB_SOURCE_LINEAGE_UNKNOWN })
  console.log(`Conservatively marked legacy rows: ${unknownRows}`)
  console.log('Verified: every posting has durable source lineage.')
}

async function main(): Promise<void> {
  await runSourceLineageRepair(process.argv.slice(2))
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Jobs source-lineage repair failed:', error)
      process.exit(1)
    })
}
