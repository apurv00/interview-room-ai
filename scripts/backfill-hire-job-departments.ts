#!/usr/bin/env tsx
/**
 * Backfill the mandatory HireJob.departmentId relation without creating an
 * untracked/null legacy window.
 *
 *   npm run backfill:hire-job-departments              # plan only
 *   npm run check:hire-job-departments                 # read-only invariant
 *   npm run backfill:hire-job-departments -- --apply   # one fallback per affected workspace
 *
 * Run the Phase 6 Department index gate first. Apply creates one reserved,
 * non-assignable `legacy` Department per workspace that still has a null or
 * missing job department, then assigns only those legacy jobs to it. The
 * script never drops data or indexes and verifies the relation after writes.
 */

import { pathToFileURL } from 'node:url'
import mongoose, { type ClientSession } from 'mongoose'
import { connectDB } from '../shared/db/connection'
import { HireDepartment } from '../modules/hire-departments/models'
import { HireJob } from '../modules/hire/models'
import {
  HIRE_PHASE6_DEPARTMENT_INDEX_DEFINITIONS,
  isExactHirePhase6DepartmentIndex,
} from './prepare-hire-phase6-department-indexes'

export const HIRE_LEGACY_DEPARTMENT_NAME = 'Unclassified legacy jobs'
export const HIRE_LEGACY_DEPARTMENT_NORMALIZED_NAME = 'unclassified legacy jobs'
export const HIRE_LEGACY_DEPARTMENT_SYSTEM_KEY = 'legacy'

export type HireJobDepartmentBackfillMode = 'plan' | 'check' | 'apply'

interface CollectionIndex {
  name?: string
  key?: Record<string, unknown>
  unique?: boolean
  partialFilterExpression?: unknown
  expireAfterSeconds?: number
  sparse?: boolean
  hidden?: boolean
  collation?: unknown
}

interface BackfillCollection {
  indexes(): Promise<CollectionIndex[]>
  aggregate<T>(pipeline: unknown[]): { toArray(): Promise<T[]> }
  countDocuments(filter: Record<string, unknown>): Promise<number>
  findOne(
    filter: Record<string, unknown>,
    options?: { session?: ClientSession },
  ): Promise<Record<string, unknown> | null>
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { upsert?: boolean; session?: ClientSession },
  ): Promise<{ matchedCount?: number; modifiedCount?: number; upsertedCount?: number }>
  updateMany(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { session?: ClientSession },
  ): Promise<{ matchedCount?: number; modifiedCount?: number }>
}

interface WorkspaceWithLegacyJobs {
  _id: unknown
  jobCount: number
}

interface LegacyDepartmentRow {
  _id: unknown
  workspaceId?: unknown
  name?: unknown
  normalizedName?: unknown
  status?: unknown
  kind?: unknown
  systemKey?: unknown
}

export function hireJobDepartmentBackfillModeOf(
  argv: string[],
): HireJobDepartmentBackfillMode {
  const supported = new Set(['--apply', '--check'])
  const unknown = argv.filter((argument) => !supported.has(argument))
  if (unknown.length) {
    throw new Error(
      `unknown argument${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`,
    )
  }
  const apply = argv.includes('--apply')
  const check = argv.includes('--check')
  if (apply && check) throw new Error('choose either --apply or --check, not both')
  return apply ? 'apply' : check ? 'check' : 'plan'
}

/** Missing and explicit null both violate the mandatory job classification. */
export function missingHireJobDepartmentFilter(): Record<string, unknown> {
  return {
    $or: [
      { departmentId: { $exists: false } },
      { departmentId: null },
    ],
  }
}

export function missingHireJobDepartmentWorkspacePipeline(): unknown[] {
  return [
    { $match: missingHireJobDepartmentFilter() },
    { $group: { _id: '$workspaceId', jobCount: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]
}

export function assertNoMissingHireJobDepartments(count: number): void {
  if (count > 0) {
    throw new Error(
      `Hire job department backfill is incomplete: ${count} job(s) still have a null or missing departmentId`,
    )
  }
}

function assertHireControlDatabaseBoundary(connection: unknown): void {
  if (process.env.IPG_SURFACE !== 'hire-control') {
    throw new Error('IPG_SURFACE must be hire-control')
  }
  const expectedDatabase = process.env.HIRE_CONTROL_DATABASE_NAME?.trim()
  const actualDatabase = (connection as { connection?: { name?: unknown } })
    ?.connection?.name
  if (!expectedDatabase || actualDatabase !== expectedDatabase) {
    throw new Error('connected database is not the configured Hire control database')
  }
}

function departmentCollection(): BackfillCollection {
  return HireDepartment.collection as unknown as BackfillCollection
}

function jobCollection(): BackfillCollection {
  return HireJob.collection as unknown as BackfillCollection
}

function departmentUniqueIndexDefinitions() {
  const definitions = HIRE_PHASE6_DEPARTMENT_INDEX_DEFINITIONS.filter(
    (candidate) => candidate.target === 'departments' && candidate.unique,
  )
  if (definitions.length !== 2) {
    throw new Error('Phase 6 Department unique index definitions are incomplete')
  }
  return definitions
}

async function assertDepartmentUniqueIndexesReady(
  departments: BackfillCollection,
): Promise<void> {
  const indexes = await departments.indexes()
  const missing = departmentUniqueIndexDefinitions().filter(
    (definition) =>
      indexes.filter((index) =>
        isExactHirePhase6DepartmentIndex(index, definition),
      ).length !== 1,
  )
  if (missing.length) {
    throw new Error(
      'the exact Phase 6 Department unique indexes must exist before legacy job backfill',
    )
  }
}

function workspaceKey(workspaceId: unknown): string {
  if (workspaceId === null || workspaceId === undefined) {
    throw new Error('legacy HireJob row has no workspaceId; backfill stopped without writing')
  }
  const value = String(workspaceId)
  if (!value || value === '[object Object]') {
    throw new Error('legacy HireJob row has an invalid workspaceId; backfill stopped without writing')
  }
  return value
}

async function workspacesNeedingBackfill(
  jobs: BackfillCollection,
): Promise<WorkspaceWithLegacyJobs[]> {
  const rows = await jobs
    .aggregate<WorkspaceWithLegacyJobs>(missingHireJobDepartmentWorkspacePipeline())
    .toArray()
  const byWorkspace = new Map<string, WorkspaceWithLegacyJobs>()
  for (const row of rows) {
    const key = workspaceKey(row._id)
    if (!Number.isInteger(row.jobCount) || row.jobCount < 1) {
      throw new Error(`legacy job backfill count is invalid for workspace ${key}`)
    }
    if (byWorkspace.has(key)) {
      throw new Error(`legacy job backfill returned duplicate workspace ${key}`)
    }
    byWorkspace.set(key, row)
  }
  return Array.from(byWorkspace.values())
}

function assertExistingDepartmentIsSafe(
  row: LegacyDepartmentRow | null,
  workspaceId: unknown,
): void {
  if (!row) return
  if (
    row.kind !== 'legacy' ||
    row.systemKey !== HIRE_LEGACY_DEPARTMENT_SYSTEM_KEY ||
    row.status !== 'active' ||
    row.name !== HIRE_LEGACY_DEPARTMENT_NAME ||
    row.normalizedName !== HIRE_LEGACY_DEPARTMENT_NORMALIZED_NAME
  ) {
    throw new Error(
      `workspace ${workspaceKey(workspaceId)} already uses the reserved legacy department name for an incompatible department; no job was changed`,
    )
  }
}

async function ensureLegacyDepartment(input: {
  departments: BackfillCollection
  workspaceId: unknown
  now: Date
  session: ClientSession
}): Promise<LegacyDepartmentRow> {
  const priorLegacy = await input.departments.findOne(
    {
      workspaceId: input.workspaceId,
      kind: 'legacy',
    },
    { session: input.session },
  ) as LegacyDepartmentRow | null
  assertExistingDepartmentIsSafe(priorLegacy, input.workspaceId)

  const priorSystemKey = await input.departments.findOne(
    {
      workspaceId: input.workspaceId,
      systemKey: HIRE_LEGACY_DEPARTMENT_SYSTEM_KEY,
    },
    { session: input.session },
  ) as LegacyDepartmentRow | null
  assertExistingDepartmentIsSafe(priorSystemKey, input.workspaceId)

  const priorName = await input.departments.findOne(
    {
      workspaceId: input.workspaceId,
      normalizedName: HIRE_LEGACY_DEPARTMENT_NORMALIZED_NAME,
    },
    { session: input.session },
  ) as LegacyDepartmentRow | null
  assertExistingDepartmentIsSafe(priorName, input.workspaceId)

  await input.departments.updateOne(
    {
      workspaceId: input.workspaceId,
      kind: 'legacy',
    },
    {
      $setOnInsert: {
        workspaceId: input.workspaceId,
        name: HIRE_LEGACY_DEPARTMENT_NAME,
        normalizedName: HIRE_LEGACY_DEPARTMENT_NORMALIZED_NAME,
        kind: 'legacy',
        systemKey: HIRE_LEGACY_DEPARTMENT_SYSTEM_KEY,
        status: 'active',
        createdAt: input.now,
        updatedAt: input.now,
      },
    },
    { upsert: true, session: input.session },
  )

  const department = await input.departments.findOne(
    {
      workspaceId: input.workspaceId,
      kind: 'legacy',
    },
    { session: input.session },
  ) as LegacyDepartmentRow | null
  assertExistingDepartmentIsSafe(department, input.workspaceId)
  if (!department?._id) {
    throw new Error('legacy department upsert did not return an identifier')
  }
  return department
}

async function backfillOneWorkspace(input: {
  workspaceId: unknown
  now: Date
  departments: BackfillCollection
  jobs: BackfillCollection
}): Promise<{ matched: number; modified: number }> {
  const session = await mongoose.startSession()
  let outcome = { matched: 0, modified: 0 }
  try {
    await session.withTransaction(async () => {
      const department = await ensureLegacyDepartment({
        departments: input.departments,
        workspaceId: input.workspaceId,
        now: input.now,
        session,
      })
      const result = await input.jobs.updateMany(
        {
          workspaceId: input.workspaceId,
          ...missingHireJobDepartmentFilter(),
        },
        {
          $set: { departmentId: department._id, updatedAt: input.now },
        },
        { session },
      )
      // A transaction callback may retry. Keep only its final durable result.
      outcome = {
        matched: result.matchedCount ?? 0,
        modified: result.modifiedCount ?? 0,
      }
    })
  } finally {
    await session.endSession()
  }
  return outcome
}

export async function backfillHireJobDepartments(
  argv: string[],
  now = new Date(),
): Promise<void> {
  const mode = hireJobDepartmentBackfillModeOf(argv)
  console.log('\nHire job department backfill')
  console.log('────────────────────────────')
  console.log(`Legacy department: ${HIRE_LEGACY_DEPARTMENT_NAME}`)
  console.log('Scope: missing/null HireJob.departmentId only')
  if (mode === 'plan') {
    console.log('\nPLAN ONLY — no database connection or write. Run the Phase 6 index check before --apply.')
    return
  }

  const connection = await connectDB({ schemaInitialization: 'disabled' })
  assertHireControlDatabaseBoundary(connection)
  const departments = departmentCollection()
  const jobs = jobCollection()
  await assertDepartmentUniqueIndexesReady(departments)

  if (mode === 'check') {
    const remaining = await jobs.countDocuments(missingHireJobDepartmentFilter())
    assertNoMissingHireJobDepartments(remaining)
    console.log('\nCHECK PASSED — every HireJob has a departmentId.')
    return
  }

  const workspaces = await workspacesNeedingBackfill(jobs)
  const affectedJobs = workspaces.reduce((total, row) => total + row.jobCount, 0)
  console.log(`Affected workspaces: ${workspaces.length}`)
  console.log(`Jobs missing a department: ${affectedJobs}`)

  let matched = 0
  let modified = 0
  for (const workspace of workspaces) {
    const result = await backfillOneWorkspace({
      workspaceId: workspace._id,
      now,
      departments,
      jobs,
    })
    matched += result.matched
    modified += result.modified
  }
  console.log(`Jobs matched: ${matched}`)
  console.log(`Jobs modified: ${modified}`)

  // Re-read after every transaction. If an old writer was still live, the
  // release fails visibly instead of claiming a null-free invariant it did
  // not actually establish.
  const remaining = await jobs.countDocuments(missingHireJobDepartmentFilter())
  assertNoMissingHireJobDepartments(remaining)
  console.log('\nAPPLY PASSED — every HireJob has a departmentId.')
}

async function main(): Promise<void> {
  await backfillHireJobDepartments(process.argv.slice(2))
}

const isMain =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Hire job department backfill failed:', error)
      process.exit(1)
    })
}
