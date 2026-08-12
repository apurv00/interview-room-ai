#!/usr/bin/env tsx
/**
 * Controlled rollout for workspace-scoped Hire member identity.
 *
 *   npm run prepare:hire-member-email-uniqueness              # plan only
 *   npm run prepare:hire-member-email-uniqueness -- --apply   # backfill/index
 *   npm run check:hire-member-email-uniqueness                # read-only gate
 *
 * Run only against the isolated Hire control database. The apply path creates
 * every replacement compound index before dropping its global predecessor, so
 * member email and credential uniqueness are never left unguarded.
 */

import { pathToFileURL } from 'node:url'
import mongoose from 'mongoose'
import { connectDB } from '../shared/db/connection'
import {
  HIRE_MEMBER_ACTIVE_EMAIL_INDEX_KEY,
  HIRE_MEMBER_ACTIVE_EMAIL_INDEX_NAME,
  HIRE_MEMBER_ACTIVE_EMAIL_INDEX_PARTIAL,
  HireWorkspaceMember,
} from '../modules/hire/models/HireWorkspaceMember'
import {
  HIRE_MEMBER_SETUP_TOKEN_INDEX_KEY,
  HIRE_MEMBER_SETUP_TOKEN_INDEX_NAME,
  HireMemberSetup,
} from '../modules/hire/models/HireMemberSetup'
import {
  HIRE_MEMBER_SESSION_TOKEN_INDEX_KEY,
  HIRE_MEMBER_SESSION_TOKEN_INDEX_NAME,
  HireMemberSession,
} from '../modules/hire/models/HireMemberSession'
import { HireWorkspace } from '../modules/hire/models/HireWorkspace'

export type HireMemberEmailMigrationMode = 'plan' | 'apply' | 'check'

export function hireMemberEmailMigrationModeOf(
  argv: string[],
): HireMemberEmailMigrationMode {
  const supported = new Set(['--apply', '--check'])
  const unknown = argv.filter((argument) => !supported.has(argument))
  if (unknown.length)
    throw new Error(`unknown arguments: ${unknown.join(', ')}`)
  const apply = argv.includes('--apply')
  const check = argv.includes('--check')
  if (apply && check)
    throw new Error('choose either --apply or --check, not both')
  return apply ? 'apply' : check ? 'check' : 'plan'
}

interface NormalizedEmailConflict {
  _id: { workspaceId: mongoose.Types.ObjectId; normalizedEmail: string }
  count: number
  memberIds: mongoose.Types.ObjectId[]
}

interface IndexDescription {
  name?: string
  key?: Record<string, unknown>
  unique?: boolean
  partialFilterExpression?: Record<string, unknown>
}

function sameKey(
  actual: Record<string, unknown> | undefined,
  expected: Record<string, unknown>,
): boolean {
  if (!actual) return false
  return (
    Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(
      ([field, direction]) => actual[field] === direction,
    )
  )
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function isExactHireMemberActiveEmailIndex(
  index: IndexDescription,
): boolean {
  return (
    index.name === HIRE_MEMBER_ACTIVE_EMAIL_INDEX_NAME &&
    sameKey(index.key, HIRE_MEMBER_ACTIVE_EMAIL_INDEX_KEY) &&
    index.unique === true &&
    sameJson(
      index.partialFilterExpression,
      HIRE_MEMBER_ACTIVE_EMAIL_INDEX_PARTIAL,
    )
  )
}

export function isExactWorkspaceTokenIndex(
  index: IndexDescription,
  expected: { name: string; key: Record<string, unknown> },
): boolean {
  return (
    index.name === expected.name &&
    sameKey(index.key, expected.key) &&
    index.unique === true
  )
}

export function assertNoHireMemberEmailConflicts(
  conflicts: NormalizedEmailConflict[],
): void {
  if (conflicts.length === 0) return
  const samples = conflicts
    .slice(0, 10)
    .map(
      (conflict) =>
        `${String(conflict._id.workspaceId)}:${conflict.memberIds.map(String).join('/')}`,
    )
    .join(', ')
  throw new Error(
    `within-workspace pending/active Hire member email conflicts=${conflicts.length}; ${samples}`,
  )
}

type WorkspaceId = mongoose.Types.ObjectId | string

export function workspaceActiveEmailConflictPipeline(workspaceId: WorkspaceId) {
  return [
    { $match: { workspaceId, authState: { $in: ['pending', 'active'] } } },
    {
      $project: {
        workspaceId: 1,
        normalizedEmail: { $toLower: { $trim: { input: '$email' } } },
      },
    },
    {
      $group: {
        _id: {
          workspaceId: '$workspaceId',
          normalizedEmail: '$normalizedEmail',
        },
        count: { $sum: 1 },
        memberIds: { $push: '$_id' },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } },
  ]
}

export function workspaceMemberIdentityIssueFilter(workspaceId: WorkspaceId) {
  return {
    workspaceId,
    $or: [
      { email: { $exists: false } },
      { email: { $not: { $type: 'string' } } },
      { email: '' },
    ],
  }
}

export function workspaceCredentialIssueFilter(workspaceId: WorkspaceId) {
  return {
    workspaceId,
    $or: [
      { memberId: { $exists: false } },
      { memberId: { $not: { $type: 'objectId' } } },
      { tokenHash: { $exists: false } },
      { tokenHash: { $not: { $type: 'string' } } },
      { tokenHash: '' },
    ],
  }
}

export function workspaceNormalizedEmailIssueFilter(workspaceId: WorkspaceId) {
  return {
    workspaceId,
    $expr: {
      $ne: ['$normalizedEmail', { $toLower: { $trim: { input: '$email' } } }],
    },
  }
}

async function activeEmailConflicts(
  workspaceIds: readonly mongoose.Types.ObjectId[],
): Promise<NormalizedEmailConflict[]> {
  const conflicts: NormalizedEmailConflict[] = []
  for (const workspaceId of workspaceIds) {
    conflicts.push(
      ...(await HireWorkspaceMember.collection
        .aggregate<NormalizedEmailConflict>(
          workspaceActiveEmailConflictPipeline(workspaceId),
        )
        .toArray()),
    )
  }
  return conflicts
}

async function invalidMemberIdentityCount(
  workspaceIds: readonly mongoose.Types.ObjectId[],
): Promise<number> {
  let count = 0
  for (const workspaceId of workspaceIds) {
    count += await HireWorkspaceMember.collection.countDocuments(
      workspaceMemberIdentityIssueFilter(workspaceId),
    )
  }
  return count
}

async function invalidCredentialScopeCount(
  workspaceIds: readonly mongoose.Types.ObjectId[],
): Promise<number> {
  let count = 0
  for (const workspaceId of workspaceIds) {
    const [setups, sessions] = await Promise.all([
      HireMemberSetup.collection.countDocuments(
        workspaceCredentialIssueFilter(workspaceId),
      ),
      HireMemberSession.collection.countDocuments(
        workspaceCredentialIssueFilter(workspaceId),
      ),
    ])
    count += setups + sessions
  }
  return count
}

async function assertDatabaseBoundary(): Promise<void> {
  if (process.env.IPG_SURFACE !== 'hire-control') {
    throw new Error('IPG_SURFACE must be hire-control')
  }
  const expected = process.env.HIRE_CONTROL_DATABASE_NAME
  if (!expected || mongoose.connection.name !== expected) {
    throw new Error(
      'connected database is not the configured Hire control database',
    )
  }
}

function hasGlobalUniqueKey(
  indexes: IndexDescription[],
  field: string,
): boolean {
  return indexes.some(
    (index) => sameKey(index.key, { [field]: 1 }) && index.unique === true,
  )
}

async function verifyMigration(
  workspaceIds: readonly mongoose.Types.ObjectId[],
): Promise<void> {
  assertNoHireMemberEmailConflicts(await activeEmailConflicts(workspaceIds))
  let missingOrWrong = 0
  for (const workspaceId of workspaceIds) {
    missingOrWrong += await HireWorkspaceMember.collection.countDocuments(
      workspaceNormalizedEmailIssueFilter(workspaceId),
    )
  }
  if (missingOrWrong > 0) {
    throw new Error(
      `Hire member normalizedEmail backfill incomplete: ${missingOrWrong}`,
    )
  }
  if (
    (await invalidMemberIdentityCount(workspaceIds)) > 0 ||
    (await invalidCredentialScopeCount(workspaceIds)) > 0
  ) {
    throw new Error(
      'one or more workspace-scoped Hire member credential rows are invalid',
    )
  }

  const [memberIndexes, setupIndexes, sessionIndexes] = await Promise.all([
    HireWorkspaceMember.collection.indexes(),
    HireMemberSetup.collection.indexes(),
    HireMemberSession.collection.indexes(),
  ])
  if (!memberIndexes.some(isExactHireMemberActiveEmailIndex)) {
    throw new Error(
      'exact workspace-scoped pending/active email unique index is missing',
    )
  }
  if (hasGlobalUniqueKey(memberIndexes, 'normalizedEmail')) {
    throw new Error(
      'global normalizedEmail unique index still crosses Hire workspaces',
    )
  }
  if (
    !setupIndexes.some((index) =>
      isExactWorkspaceTokenIndex(index, {
        name: HIRE_MEMBER_SETUP_TOKEN_INDEX_NAME,
        key: HIRE_MEMBER_SETUP_TOKEN_INDEX_KEY,
      }),
    )
  ) {
    throw new Error('workspace-scoped member setup token index is missing')
  }
  if (
    !sessionIndexes.some((index) =>
      isExactWorkspaceTokenIndex(index, {
        name: HIRE_MEMBER_SESSION_TOKEN_INDEX_NAME,
        key: HIRE_MEMBER_SESSION_TOKEN_INDEX_KEY,
      }),
    )
  ) {
    throw new Error('workspace-scoped member session token index is missing')
  }
  if (
    hasGlobalUniqueKey(setupIndexes, 'tokenHash') ||
    hasGlobalUniqueKey(sessionIndexes, 'tokenHash')
  ) {
    throw new Error('global member token index still crosses Hire workspaces')
  }
}

async function createReplacementIndexes(): Promise<void> {
  await HireWorkspaceMember.collection.createIndex(
    HIRE_MEMBER_ACTIVE_EMAIL_INDEX_KEY,
    {
      name: HIRE_MEMBER_ACTIVE_EMAIL_INDEX_NAME,
      unique: true,
      partialFilterExpression: HIRE_MEMBER_ACTIVE_EMAIL_INDEX_PARTIAL,
    },
  )
  await HireMemberSetup.collection.createIndex(
    HIRE_MEMBER_SETUP_TOKEN_INDEX_KEY,
    { name: HIRE_MEMBER_SETUP_TOKEN_INDEX_NAME, unique: true },
  )
  await HireMemberSession.collection.createIndex(
    HIRE_MEMBER_SESSION_TOKEN_INDEX_KEY,
    { name: HIRE_MEMBER_SESSION_TOKEN_INDEX_NAME, unique: true },
  )
}

async function dropCrossWorkspaceIndexes(): Promise<void> {
  const collections = [
    {
      collection: HireWorkspaceMember.collection,
      globalFields: ['normalizedEmail', 'email'],
    },
    { collection: HireMemberSetup.collection, globalFields: ['tokenHash'] },
    { collection: HireMemberSession.collection, globalFields: ['tokenHash'] },
  ]
  for (const { collection, globalFields } of collections) {
    for (const index of await collection.indexes()) {
      if (
        index.name &&
        globalFields.some((field) => sameKey(index.key, { [field]: 1 }))
      ) {
        await collection.dropIndex(index.name)
      }
    }
  }
  for (const index of await HireWorkspaceMember.collection.indexes()) {
    if (
      index.name &&
      sameKey(index.key, { workspaceId: 1, email: 1 }) &&
      index.unique === true
    ) {
      await HireWorkspaceMember.collection.dropIndex(index.name)
    }
  }
}

export async function runHireMemberEmailMigration(
  argv: string[],
): Promise<void> {
  const mode = hireMemberEmailMigrationModeOf(argv)
  console.log('\nHire member workspace-scoping rollout')
  console.log('──────────────────────────────────────')
  console.log(`Email index: ${HIRE_MEMBER_ACTIVE_EMAIL_INDEX_NAME}`)
  console.log('Scope: workspaceId + normalizedEmail/tokenHash')
  if (mode === 'plan') {
    console.log(
      '\nPLAN ONLY — no database connection or write. Re-run with --apply.',
    )
    return
  }

  await connectDB({ schemaInitialization: 'disabled' })
  await assertDatabaseBoundary()
  const roots = await HireWorkspace.find({}, { _id: 1 }).sort({ _id: 1 }).lean()
  const workspaceIds = roots.map((root) => root._id)
  const invalidMembers = await invalidMemberIdentityCount(workspaceIds)
  const invalidCredentials = await invalidCredentialScopeCount(workspaceIds)
  if (invalidMembers > 0 || invalidCredentials > 0) {
    throw new Error(
      `invalid Hire member rows=${invalidMembers}; invalid credential rows=${invalidCredentials}`,
    )
  }
  assertNoHireMemberEmailConflicts(await activeEmailConflicts(workspaceIds))

  if (mode === 'check') {
    await verifyMigration(workspaceIds)
    console.log(
      '\nCHECK PASSED — member identity and credentials are workspace-scoped.',
    )
    return
  }

  for (const workspaceId of workspaceIds) {
    await HireWorkspaceMember.collection.updateMany({ workspaceId }, [
      {
        $set: { normalizedEmail: { $toLower: { $trim: { input: '$email' } } } },
      },
    ])
  }
  await createReplacementIndexes()
  await dropCrossWorkspaceIndexes()
  for (const workspaceId of workspaceIds) {
    await HireWorkspaceMember.collection.updateMany({ workspaceId }, [
      { $set: { email: '$normalizedEmail' } },
    ])
  }
  await verifyMigration(workspaceIds)
  console.log('\nAPPLY PASSED — scoped backfill and exact indexes verified.')
}

async function main() {
  await runHireMemberEmailMigration(process.argv.slice(2))
}

const isMain =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Hire member workspace-scoping rollout failed:', error)
      process.exit(1)
    })
}
