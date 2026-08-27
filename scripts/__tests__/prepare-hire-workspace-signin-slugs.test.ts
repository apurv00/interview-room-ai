import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import mongoose from 'mongoose'

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(),
  workspaceFind: vi.fn(),
  workspaceToArray: vi.fn(),
  workspaceUpdateOne: vi.fn(),
  workspaceIndexes: vi.fn(),
  workspaceCreateIndex: vi.fn(),
  reservationFind: vi.fn(),
  reservationToArray: vi.fn(),
  reservationInsertOne: vi.fn(),
  reservationIndexes: vi.fn(),
  reservationCreateIndex: vi.fn(),
}))

vi.mock('../../shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('../../modules/hire/models', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../modules/hire/models')>()
  return {
    ...original,
    HireWorkspace: {
      collection: {
        find: (...args: unknown[]) => mocks.workspaceFind(...args),
        updateOne: (...args: unknown[]) => mocks.workspaceUpdateOne(...args),
        indexes: (...args: unknown[]) => mocks.workspaceIndexes(...args),
        createIndex: (...args: unknown[]) => mocks.workspaceCreateIndex(...args),
      },
    },
    HireWorkspaceSignInSlug: {
      collection: {
        find: (...args: unknown[]) => mocks.reservationFind(...args),
        insertOne: (...args: unknown[]) => mocks.reservationInsertOne(...args),
        indexes: (...args: unknown[]) => mocks.reservationIndexes(...args),
        createIndex: (...args: unknown[]) => mocks.reservationCreateIndex(...args),
      },
    },
  }
})

import {
  hireWorkspaceSignInSlugPreparationModeOf,
  planHireWorkspaceSignInSlugAssignments,
  prepareHireWorkspaceSignInSlugs,
} from '../prepare-hire-workspace-signin-slugs'
import {
  HIRE_WORKSPACE_SIGN_IN_RESERVATION_INDEX_KEY,
  HIRE_WORKSPACE_SIGN_IN_RESERVATION_INDEX_NAME,
  HIRE_WORKSPACE_SIGN_IN_RESERVATION_INDEX_PARTIAL,
  HIRE_WORKSPACE_SIGN_IN_SLUG_INDEX_KEY,
  HIRE_WORKSPACE_SIGN_IN_SLUG_INDEX_NAME,
  HIRE_WORKSPACE_SIGN_IN_SLUG_INDEX_PARTIAL,
  hireWorkspaceSignInSlugHash,
} from '../../modules/hire/models'

const WORKSPACE_A = new mongoose.Types.ObjectId('111111111111111111111111')
const WORKSPACE_B = new mongoose.Types.ObjectId('222222222222222222222222')

const session = {
  withTransaction: vi.fn(async (work: () => Promise<unknown>) => work()),
  endSession: vi.fn().mockResolvedValue(undefined),
}

const exactWorkspaceIndex = {
  name: HIRE_WORKSPACE_SIGN_IN_SLUG_INDEX_NAME,
  key: HIRE_WORKSPACE_SIGN_IN_SLUG_INDEX_KEY,
  unique: true,
  partialFilterExpression: HIRE_WORKSPACE_SIGN_IN_SLUG_INDEX_PARTIAL,
}
const exactReservationIndex = {
  name: HIRE_WORKSPACE_SIGN_IN_RESERVATION_INDEX_NAME,
  key: HIRE_WORKSPACE_SIGN_IN_RESERVATION_INDEX_KEY,
  unique: true,
  partialFilterExpression: HIRE_WORKSPACE_SIGN_IN_RESERVATION_INDEX_PARTIAL,
}

describe('Hire workspace sign-in slug preparation', () => {
  const originalSurface = process.env.IPG_SURFACE
  const originalDatabase = process.env.HIRE_CONTROL_DATABASE_NAME

  beforeEach(() => {
    vi.resetAllMocks()
    process.env.IPG_SURFACE = 'hire-control'
    process.env.HIRE_CONTROL_DATABASE_NAME = 'hire-control'
    mocks.connectDB.mockResolvedValue({ connection: { name: 'hire-control' } })
    mocks.workspaceFind.mockImplementation(() => ({
      sort: () => ({ toArray: mocks.workspaceToArray }),
    }))
    mocks.reservationFind.mockImplementation(() => ({
      toArray: mocks.reservationToArray,
    }))
    mocks.workspaceUpdateOne.mockResolvedValue({ modifiedCount: 1 })
    mocks.reservationInsertOne.mockResolvedValue({ acknowledged: true })
    mocks.workspaceCreateIndex.mockResolvedValue(
      HIRE_WORKSPACE_SIGN_IN_SLUG_INDEX_NAME,
    )
    mocks.reservationCreateIndex.mockResolvedValue(
      HIRE_WORKSPACE_SIGN_IN_RESERVATION_INDEX_NAME,
    )
    session.withTransaction.mockImplementation(
      async (work: () => Promise<unknown>) => work(),
    )
    session.endSession.mockResolvedValue(undefined)
    vi.spyOn(mongoose, 'startSession').mockResolvedValue(session as never)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    if (originalSurface === undefined) delete process.env.IPG_SURFACE
    else process.env.IPG_SURFACE = originalSurface
    if (originalDatabase === undefined) delete process.env.HIRE_CONTROL_DATABASE_NAME
    else process.env.HIRE_CONTROL_DATABASE_NAME = originalDatabase
    vi.restoreAllMocks()
  })

  it('keeps plan disconnected by default and validates operation flags', () => {
    expect(hireWorkspaceSignInSlugPreparationModeOf([])).toBe('plan')
    expect(hireWorkspaceSignInSlugPreparationModeOf(['--check'])).toBe('check')
    expect(hireWorkspaceSignInSlugPreparationModeOf(['--apply'])).toBe('apply')
    expect(() =>
      hireWorkspaceSignInSlugPreparationModeOf(['--apply', '--check']),
    ).toThrow('mutually exclusive')
    expect(() => hireWorkspaceSignInSlugPreparationModeOf(['--drop'])).toThrow(
      'unknown argument',
    )
  })

  it('assigns duplicate company names deterministically without making names unique', () => {
    const assignments = planHireWorkspaceSignInSlugAssignments(
      [
        { _id: WORKSPACE_B, name: 'Acme' },
        { _id: WORKSPACE_A, name: 'Acme' },
      ],
      [],
    )

    expect(assignments.map(({ workspaceId, slug }) => [workspaceId.toString(), slug]))
      .toEqual([
        [WORKSPACE_A.toString(), 'acme'],
        [WORKSPACE_B.toString(), 'acme-22222222'],
      ])
  })

  it('is idempotent once exact active reservations exist', () => {
    const slug = 'acme'
    expect(
      planHireWorkspaceSignInSlugAssignments(
        [{ _id: WORKSPACE_A, name: 'Acme', signInSlug: slug }],
        [
          {
            _id: hireWorkspaceSignInSlugHash(slug),
            slug,
            workspaceId: WORKSPACE_A,
            state: 'active',
          },
        ],
      ),
    ).toEqual([])
  })

  it('never reuses a retired slug and fails on orphan active reservations', () => {
    const retiredHash = hireWorkspaceSignInSlugHash('acme')
    expect(
      planHireWorkspaceSignInSlugAssignments(
        [{ _id: WORKSPACE_B, name: 'Acme' }],
        [{ _id: retiredHash, state: 'retired' }],
      )[0]?.slug,
    ).toBe('acme-22222222')

    expect(() =>
      planHireWorkspaceSignInSlugAssignments(
        [{ _id: WORKSPACE_A, name: 'Acme' }],
        [
          {
            _id: hireWorkspaceSignInSlugHash('orphan'),
            slug: 'orphan',
            workspaceId: WORKSPACE_B,
            state: 'active',
          },
        ],
      ),
    ).toThrow('orphan active')
  })

  it.each([
    {
      name: 'an unknown state',
      reservation: {
        _id: hireWorkspaceSignInSlugHash('acme'),
        slug: 'acme',
        workspaceId: WORKSPACE_A,
        state: 'pending',
      },
      error: 'invalid state',
    },
    {
      name: 'a string workspaceId',
      reservation: {
        _id: hireWorkspaceSignInSlugHash('acme'),
        slug: 'acme',
        workspaceId: WORKSPACE_A.toString(),
        state: 'active',
      },
      error: 'non-ObjectId workspaceId',
    },
    {
      name: 'a non-canonical hash id',
      reservation: {
        _id: hireWorkspaceSignInSlugHash('acme').toUpperCase(),
        slug: 'acme',
        workspaceId: WORKSPACE_A,
        state: 'active',
      },
      error: 'invalid lowercase hash id',
    },
    {
      name: 'a hash that does not match its live slug',
      reservation: {
        _id: hireWorkspaceSignInSlugHash('other'),
        slug: 'acme',
        workspaceId: WORKSPACE_A,
        state: 'active',
      },
      error: 'does not match its slug hash',
    },
  ])('fails closed on a raw reservation with $name', ({ reservation, error }) => {
    expect(() =>
      planHireWorkspaceSignInSlugAssignments(
        [{ _id: WORKSPACE_A, name: 'Acme', signInSlug: 'acme' }],
        [reservation],
      ),
    ).toThrow(error)
  })

  it('fails incompatible-index preflight before any data or index write', async () => {
    const slug = 'acme'
    mocks.workspaceToArray.mockResolvedValue([
      { _id: WORKSPACE_A, name: 'Acme', signInSlug: slug },
    ])
    mocks.reservationToArray.mockResolvedValue([
      {
        _id: hireWorkspaceSignInSlugHash(slug),
        slug,
        workspaceId: WORKSPACE_A,
        state: 'active',
      },
    ])
    mocks.workspaceIndexes.mockResolvedValue([{ ...exactWorkspaceIndex, hidden: true }])
    mocks.reservationIndexes.mockResolvedValue([exactReservationIndex])

    await expect(
      prepareHireWorkspaceSignInSlugs(['--apply']),
    ).rejects.toThrow('incompatible workspaces index')

    expect(mongoose.startSession).not.toHaveBeenCalled()
    expect(mocks.reservationInsertOne).not.toHaveBeenCalled()
    expect(mocks.workspaceUpdateOne).not.toHaveBeenCalled()
    expect(mocks.workspaceCreateIndex).not.toHaveBeenCalled()
    expect(mocks.reservationCreateIndex).not.toHaveBeenCalled()
  })

  it('applies transactionally and rereads all data and indexes before success', async () => {
    const slug = 'acme'
    const reservation = {
      _id: hireWorkspaceSignInSlugHash(slug),
      slug,
      workspaceId: WORKSPACE_A,
      state: 'active' as const,
    }
    mocks.workspaceToArray
      .mockResolvedValueOnce([{ _id: WORKSPACE_A, name: 'Acme' }])
      .mockResolvedValueOnce([
        { _id: WORKSPACE_A, name: 'Acme', signInSlug: slug },
      ])
    mocks.reservationToArray
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([reservation])
    mocks.workspaceIndexes
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([exactWorkspaceIndex])
    mocks.reservationIndexes
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([exactReservationIndex])

    await prepareHireWorkspaceSignInSlugs(['--apply'])

    expect(mocks.connectDB).toHaveBeenCalledWith({
      schemaInitialization: 'disabled',
    })
    expect(session.withTransaction).toHaveBeenCalledOnce()
    expect(mocks.reservationInsertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: reservation._id,
        slug,
        workspaceId: WORKSPACE_A,
        state: 'active',
      }),
      { session },
    )
    expect(mocks.workspaceUpdateOne).toHaveBeenCalledWith(
      { _id: WORKSPACE_A, signInSlug: { $exists: false } },
      { $set: { signInSlug: slug } },
      { session },
    )
    expect(mocks.workspaceCreateIndex).toHaveBeenCalledOnce()
    expect(mocks.reservationCreateIndex).toHaveBeenCalledOnce()
    expect(mocks.workspaceToArray).toHaveBeenCalledTimes(2)
    expect(mocks.reservationToArray).toHaveBeenCalledTimes(2)
    expect(mocks.workspaceIndexes).toHaveBeenCalledTimes(2)
    expect(mocks.reservationIndexes).toHaveBeenCalledTimes(2)
    expect(console.log).toHaveBeenCalledWith(
      'APPLY PASSED — wrote 1 assignment(s); all workspace slugs, reservations, and indexes are exact.',
    )
  })

  it('keeps exact check mode idempotent and read-only', async () => {
    const slug = 'acme'
    mocks.workspaceToArray.mockResolvedValue([
      { _id: WORKSPACE_A, name: 'Acme', signInSlug: slug },
    ])
    mocks.reservationToArray.mockResolvedValue([
      {
        _id: hireWorkspaceSignInSlugHash(slug),
        slug,
        workspaceId: WORKSPACE_A,
        state: 'active',
      },
    ])
    mocks.workspaceIndexes.mockResolvedValue([exactWorkspaceIndex])
    mocks.reservationIndexes.mockResolvedValue([exactReservationIndex])

    await prepareHireWorkspaceSignInSlugs(['--check'])

    expect(mongoose.startSession).not.toHaveBeenCalled()
    expect(mocks.reservationInsertOne).not.toHaveBeenCalled()
    expect(mocks.workspaceUpdateOne).not.toHaveBeenCalled()
    expect(mocks.workspaceCreateIndex).not.toHaveBeenCalled()
    expect(mocks.reservationCreateIndex).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith(
      'CHECK PASSED — 1 workspaces and 2 indexes are exact.',
    )
  })
})
