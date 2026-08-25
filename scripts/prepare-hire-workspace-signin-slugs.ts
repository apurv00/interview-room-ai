#!/usr/bin/env tsx
/**
 * Explicit, non-dropping Hire workspace sign-in slug backfill and index prep.
 *
 *   npm run prepare:hire-workspace-signin-slugs              # plan only
 *   npm run check:hire-workspace-signin-slugs                # read-only check
 *   npm run prepare:hire-workspace-signin-slugs -- --apply   # backfill + indexes
 *
 * Run this only after the compatible slug-writing and slug-retiring application
 * is deployed. An older hard-purge worker must not run after reservations exist.
 */

import mongoose from 'mongoose'
import { pathToFileURL } from 'node:url'
import { connectDB } from '../shared/db/connection'
import {
  HireWorkspace,
  HireWorkspaceSignInSlug,
  HIRE_WORKSPACE_SIGN_IN_RESERVATION_INDEX_KEY,
  HIRE_WORKSPACE_SIGN_IN_RESERVATION_INDEX_NAME,
  HIRE_WORKSPACE_SIGN_IN_RESERVATION_INDEX_PARTIAL,
  HIRE_WORKSPACE_SIGN_IN_SLUG_INDEX_KEY,
  HIRE_WORKSPACE_SIGN_IN_SLUG_INDEX_NAME,
  HIRE_WORKSPACE_SIGN_IN_SLUG_INDEX_PARTIAL,
  hireWorkspaceSignInSlugCandidates,
  hireWorkspaceSignInSlugHash,
  parseHireWorkspaceSignInSlug,
} from '../modules/hire/models'

export type HireWorkspaceSignInSlugPreparationMode =
  | 'plan'
  | 'check'
  | 'apply'
  | 'help'

interface WorkspaceRow {
  _id: mongoose.Types.ObjectId
  name: string
  signInSlug?: string
}

interface ReservationRow {
  _id: unknown
  slug?: unknown
  workspaceId?: unknown
  state?: unknown
}

type ValidReservationRow =
  | {
      _id: string
      slug: string
      workspaceId: mongoose.Types.ObjectId
      state: 'active'
    }
  | {
      _id: string
      slug?: undefined
      workspaceId?: undefined
      state: 'retired'
    }

export interface WorkspaceSignInSlugAssignment {
  workspaceId: mongoose.Types.ObjectId
  slug: string
  reservationHash: string
  writeWorkspaceSlug: boolean
}

interface IndexDescription {
  name?: string
  key?: Record<string, unknown>
  unique?: boolean
  partialFilterExpression?: unknown
  sparse?: boolean
  hidden?: boolean
  collation?: unknown
  expireAfterSeconds?: number
}

interface IndexCollection {
  createIndex(
    key: Readonly<Record<string, 1>>,
    options: {
      name: string
      unique: true
      partialFilterExpression: Record<string, unknown>
    },
  ): Promise<string>
  indexes(): Promise<IndexDescription[]>
}

const INDEX_DEFINITIONS = [
  {
    target: 'workspaces' as const,
    name: HIRE_WORKSPACE_SIGN_IN_SLUG_INDEX_NAME,
    key: HIRE_WORKSPACE_SIGN_IN_SLUG_INDEX_KEY,
    partialFilterExpression: HIRE_WORKSPACE_SIGN_IN_SLUG_INDEX_PARTIAL,
  },
  {
    target: 'reservations' as const,
    name: HIRE_WORKSPACE_SIGN_IN_RESERVATION_INDEX_NAME,
    key: HIRE_WORKSPACE_SIGN_IN_RESERVATION_INDEX_KEY,
    partialFilterExpression: HIRE_WORKSPACE_SIGN_IN_RESERVATION_INDEX_PARTIAL,
  },
] as const

export function hireWorkspaceSignInSlugPreparationModeOf(
  argv: string[],
): HireWorkspaceSignInSlugPreparationMode {
  const supported = new Set(['--apply', '--check', '--help', '-h'])
  const unknown = argv.filter((argument) => !supported.has(argument))
  if (unknown.length) throw new Error(`unknown argument: ${unknown.join(', ')}`)
  const help = argv.includes('--help') || argv.includes('-h')
  const apply = argv.includes('--apply')
  const check = argv.includes('--check')
  if (help && argv.length > 1) throw new Error('--help cannot be combined')
  if (apply && check) throw new Error('--apply and --check are mutually exclusive')
  if (help) return 'help'
  return apply ? 'apply' : check ? 'check' : 'plan'
}

function validateReservationRow(row: ReservationRow): ValidReservationRow {
  if (typeof row._id !== 'string' || !/^[a-f0-9]{64}$/.test(row._id)) {
    throw new Error('sign-in reservation has invalid lowercase hash id')
  }
  if (row.state !== 'active' && row.state !== 'retired') {
    throw new Error(`sign-in reservation ${row._id} has invalid state`)
  }
  if (row.state === 'retired') {
    if (row.slug !== undefined || row.workspaceId !== undefined) {
      throw new Error(`retired reservation ${row._id} retains live fields`)
    }
    return { _id: row._id, state: 'retired' }
  }
  if (
    typeof row.slug !== 'string' ||
    parseHireWorkspaceSignInSlug(row.slug) !== row.slug
  ) {
    throw new Error(`active reservation ${row._id} has invalid slug`)
  }
  if (hireWorkspaceSignInSlugHash(row.slug) !== row._id) {
    throw new Error(`active reservation ${row._id} does not match its slug hash`)
  }
  if (!(row.workspaceId instanceof mongoose.Types.ObjectId)) {
    throw new Error(`active reservation ${row._id} has non-ObjectId workspaceId`)
  }
  return {
    _id: row._id,
    slug: row.slug,
    workspaceId: row.workspaceId,
    state: 'active',
  }
}

/**
 * Build a deterministic, complete backfill before making any database write.
 * Existing and retired reservations both permanently occupy their hash.
 */
export function planHireWorkspaceSignInSlugAssignments(
  workspaceRows: readonly WorkspaceRow[],
  reservationRows: readonly ReservationRow[],
): WorkspaceSignInSlugAssignment[] {
  const workspaces = [...workspaceRows].sort((left, right) =>
    left._id.toString().localeCompare(right._id.toString()),
  )
  const validatedReservations = reservationRows.map(validateReservationRow)
  const reservations = new Map(
    validatedReservations.map((row) => [row._id, row]),
  )
  const occupiedSlugs = new Map<string, string>()
  const matchedActiveReservations = new Set<string>()
  const assignments: WorkspaceSignInSlugAssignment[] = []

  for (const row of workspaces.filter((workspace) => workspace.signInSlug)) {
    const slug = row.signInSlug ?? ''
    if (parseHireWorkspaceSignInSlug(slug) !== slug) {
      throw new Error(`workspace ${row._id.toString()} has invalid signInSlug`)
    }
    const previousWorkspaceId = occupiedSlugs.get(slug)
    if (previousWorkspaceId) {
      throw new Error(
        `duplicate signInSlug ${slug} on ${previousWorkspaceId} and ${row._id.toString()}`,
      )
    }
    occupiedSlugs.set(slug, row._id.toString())

    const reservationHash = hireWorkspaceSignInSlugHash(slug)
    const reservation = reservations.get(reservationHash)
    if (reservation) {
      if (
        reservation.state !== 'active' ||
        reservation.slug !== slug ||
        !reservation.workspaceId.equals(row._id)
      ) {
        throw new Error(`reservation conflict for workspace signInSlug ${slug}`)
      }
      matchedActiveReservations.add(reservationHash)
    } else {
      assignments.push({
        workspaceId: row._id,
        slug,
        reservationHash,
        writeWorkspaceSlug: false,
      })
    }
  }

  for (const reservation of validatedReservations) {
    if (
      reservation.state === 'active' &&
      !matchedActiveReservations.has(reservation._id)
    ) {
      throw new Error(`orphan active sign-in reservation ${reservation._id}`)
    }
  }

  for (const row of workspaces.filter((workspace) => !workspace.signInSlug)) {
    const slug = hireWorkspaceSignInSlugCandidates(row.name, row._id).find(
      (candidate) =>
        !occupiedSlugs.has(candidate) &&
        !reservations.has(hireWorkspaceSignInSlugHash(candidate)),
    )
    if (!slug) {
      throw new Error(`no sign-in slug candidate available for ${row._id.toString()}`)
    }
    const reservationHash = hireWorkspaceSignInSlugHash(slug)
    occupiedSlugs.set(slug, row._id.toString())
    reservations.set(reservationHash, {
      _id: reservationHash,
      slug,
      workspaceId: row._id,
      state: 'active',
    })
    assignments.push({
      workspaceId: row._id,
      slug,
      reservationHash,
      writeWorkspaceSlug: true,
    })
  }

  return assignments
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

function exactIndex(
  index: IndexDescription,
  definition: (typeof INDEX_DEFINITIONS)[number],
): boolean {
  return (
    index.name === definition.name &&
    sameJson(index.key, definition.key) &&
    index.unique === true &&
    index.sparse !== true &&
    index.hidden !== true &&
    index.collation === undefined &&
    index.expireAfterSeconds === undefined &&
    sameJson(
      index.partialFilterExpression,
      definition.partialFilterExpression,
    )
  )
}

async function readIndexes(collection: IndexCollection): Promise<IndexDescription[]> {
  try {
    return await collection.indexes()
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      ((error as { code?: unknown }).code === 26 ||
        (error as { codeName?: unknown }).codeName === 'NamespaceNotFound')
    ) {
      return []
    }
    throw error
  }
}

function assertNoIncompatibleIndex(
  indexes: readonly IndexDescription[],
  definition: (typeof INDEX_DEFINITIONS)[number],
): void {
  for (const index of indexes) {
    const sameName = index.name === definition.name
    const sameKey = sameJson(index.key, definition.key)
    if ((sameName || sameKey) && !exactIndex(index, definition)) {
      throw new Error(
        `incompatible ${definition.target} index ${index.name ?? '(unnamed)'}; no data was changed`,
      )
    }
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

function printUsage(): void {
  console.log(`Hire workspace sign-in slug preparation

  (default)  print the plan; no database connection
  --check    require every workspace/reservation and exact index
  --apply    backfill missing slugs/reservations and create missing indexes

No command drops an index, renames a workspace, or changes internal IDs.`)
}

export async function prepareHireWorkspaceSignInSlugs(
  argv: string[],
): Promise<void> {
  const mode = hireWorkspaceSignInSlugPreparationModeOf(argv)
  if (mode === 'help') {
    printUsage()
    return
  }
  console.log(
    'Plan: immutable readable workspace slugs + permanent hashed reservations + 2 exact unique indexes.',
  )
  if (mode === 'plan') {
    console.log('PLAN ONLY — no database connection or write.')
    return
  }

  const connection = await connectDB({ schemaInitialization: 'disabled' })
  assertHireControlDatabaseBoundary(connection)
  const workspaceCollection = HireWorkspace.collection
  const reservationCollection = HireWorkspaceSignInSlug.collection
  const reservationWrites = reservationCollection as unknown as {
    insertOne(
      document: {
        _id: string
        slug: string
        workspaceId: mongoose.Types.ObjectId
        state: 'active'
        createdAt: Date
        updatedAt: Date
      },
      options: { session: mongoose.ClientSession },
    ): Promise<unknown>
  }
  const [workspaces, reservations] = await Promise.all([
    workspaceCollection
      .find<WorkspaceRow>({}, { projection: { _id: 1, name: 1, signInSlug: 1 } })
      .sort({ _id: 1 })
      .toArray(),
    reservationCollection
      .find<ReservationRow>(
        {},
        { projection: { _id: 1, slug: 1, workspaceId: 1, state: 1 } },
      )
      .toArray(),
  ])
  const assignments = planHireWorkspaceSignInSlugAssignments(
    workspaces,
    reservations,
  )

  const collections = {
    workspaces: workspaceCollection as unknown as IndexCollection,
    reservations: reservationCollection as unknown as IndexCollection,
  }
  const indexes = {
    workspaces: await readIndexes(collections.workspaces),
    reservations: await readIndexes(collections.reservations),
  }
  for (const definition of INDEX_DEFINITIONS) {
    assertNoIncompatibleIndex(indexes[definition.target], definition)
  }

  if (mode === 'check') {
    if (assignments.length) {
      throw new Error(`${assignments.length} workspace slug assignment(s) are missing`)
    }
    for (const definition of INDEX_DEFINITIONS) {
      if (!indexes[definition.target].some((index) => exactIndex(index, definition))) {
        throw new Error(`missing exact index ${definition.name}`)
      }
    }
    console.log(
      `CHECK PASSED — ${workspaces.length} workspaces and ${INDEX_DEFINITIONS.length} indexes are exact.`,
    )
    return
  }

  if (assignments.length) {
    const session = await mongoose.startSession()
    try {
      await session.withTransaction(async () => {
        for (const assignment of assignments) {
          await reservationWrites.insertOne(
            {
              _id: assignment.reservationHash,
              slug: assignment.slug,
              workspaceId: assignment.workspaceId,
              state: 'active',
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            { session },
          )
          if (assignment.writeWorkspaceSlug) {
            const updated = await workspaceCollection.updateOne(
              {
                _id: assignment.workspaceId,
                signInSlug: { $exists: false },
              },
              { $set: { signInSlug: assignment.slug } },
              { session },
            )
            if (updated.modifiedCount !== 1) {
              throw new Error(
                `workspace ${assignment.workspaceId.toString()} changed during backfill`,
              )
            }
          }
        }
      })
    } finally {
      await session.endSession()
    }
  }

  for (const definition of INDEX_DEFINITIONS) {
    if (!indexes[definition.target].some((index) => exactIndex(index, definition))) {
      const indexName = await collections[definition.target].createIndex(
        definition.key,
        {
          name: definition.name,
          unique: true,
          partialFilterExpression: definition.partialFilterExpression,
        },
      )
      console.log(`Prepared ${definition.target}.${indexName}`)
    }
  }

  const [verifiedWorkspaces, verifiedReservations] = await Promise.all([
    workspaceCollection
      .find<WorkspaceRow>({}, { projection: { _id: 1, name: 1, signInSlug: 1 } })
      .sort({ _id: 1 })
      .toArray(),
    reservationCollection
      .find<ReservationRow>(
        {},
        { projection: { _id: 1, slug: 1, workspaceId: 1, state: 1 } },
      )
      .toArray(),
  ])
  const remainingAssignments = planHireWorkspaceSignInSlugAssignments(
    verifiedWorkspaces,
    verifiedReservations,
  )
  if (remainingAssignments.length) {
    throw new Error(
      `post-apply verification found ${remainingAssignments.length} missing assignment(s)`,
    )
  }
  for (const definition of INDEX_DEFINITIONS) {
    const verifiedIndexes = await readIndexes(collections[definition.target])
    if (!verifiedIndexes.some((index) => exactIndex(index, definition))) {
      throw new Error(`post-apply verification failed for ${definition.name}`)
    }
  }

  console.log(
    `APPLY PASSED — wrote ${assignments.length} assignment(s); all workspace slugs, reservations, and indexes are exact.`,
  )
}

async function main(): Promise<void> {
  await prepareHireWorkspaceSignInSlugs(process.argv.slice(2))
}

const isMain =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Hire workspace sign-in slug preparation failed:', error)
      process.exit(1)
    })
}
