import mongoose from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  roundFindOne: vi.fn(),
  roundUpdateOne: vi.fn(),
}))

vi.mock('../models/HireRound', () => ({
  HireRound: {
    findOne: mocks.roundFindOne,
    updateOne: mocks.roundUpdateOne,
  },
}))

import {
  HIRE_INGESTION_RESERVATION_LEASE_MS,
  __hireIngestionRevisionReservation,
  reserveHireRoundIngestion,
} from '../services/ingestionRevisionReservationService'

const IDS = {
  workspaceId: 'a'.repeat(24),
  applicationId: 'b'.repeat(24),
  roundId: 'c'.repeat(24),
  runtimeSessionId: 'd'.repeat(24),
}

type Head = {
  runtimeSessionId: mongoose.Types.ObjectId
  attempt: number
  revision: number
  eventId: string
  digest: string
  status: 'reserved' | 'processed'
  reservationToken?: string
  leaseExpiresAt?: Date
}

function query<T>(value: T) {
  const chain = {
    select: vi.fn(),
    session: vi.fn(),
    lean: vi.fn().mockResolvedValue(value),
  }
  chain.select.mockReturnValue(chain)
  chain.session.mockReturnValue(chain)
  return chain
}

function cloneHead(head: Head | undefined): Head | undefined {
  return head
    ? {
        ...head,
        runtimeSessionId: new mongoose.Types.ObjectId(head.runtimeSessionId),
        ...(head.leaseExpiresAt
          ? { leaseExpiresAt: new Date(head.leaseExpiresAt) }
          : {}),
      }
    : undefined
}

function installAtomicRound(initial?: Head) {
  let head = cloneHead(initial)
  mocks.roundFindOne.mockImplementation(() =>
    query({
      runtimeSessionId: new mongoose.Types.ObjectId(IDS.runtimeSessionId),
      ingestionReservations: { engineResult: cloneHead(head) },
    }),
  )
  mocks.roundUpdateOne.mockImplementation(
    async (_filter: unknown, update: { $set?: Record<string, unknown> }) => {
      const candidate = update.$set?.[
        'ingestionReservations.engineResult'
      ] as Head | undefined
      if (!candidate) return { matchedCount: 0 }
      const canClaim =
        !head ||
        (head.status === 'processed' &&
          (head.attempt < candidate.attempt ||
            (head.attempt === candidate.attempt &&
              head.revision < candidate.revision))) ||
        (head.status === 'reserved' &&
          head.attempt === candidate.attempt &&
          head.revision === candidate.revision &&
          head.eventId === candidate.eventId &&
          head.digest === candidate.digest &&
          Boolean(
            head.leaseExpiresAt &&
              candidate.leaseExpiresAt &&
              head.leaseExpiresAt <=
                new Date(
                  candidate.leaseExpiresAt.getTime() -
                    HIRE_INGESTION_RESERVATION_LEASE_MS,
                ),
          ))
      if (!canClaim) return { matchedCount: 0 }
      head = cloneHead(candidate)
      return { matchedCount: 1 }
    },
  )
  const session = {
    withTransaction: vi.fn(async (work: () => Promise<void>) => {
      const snapshot = cloneHead(head)
      try {
        await work()
      } catch (error) {
        head = snapshot
        throw error
      }
    }),
    endSession: vi.fn().mockResolvedValue(undefined),
  }
  vi.spyOn(mongoose, 'startSession').mockResolvedValue(session as never)
  return { read: () => cloneHead(head) }
}

function input(overrides: Partial<Parameters<typeof reserveHireRoundIngestion>[0]> = {}) {
  return {
    stream: 'engineResult' as const,
    workspaceId: IDS.workspaceId,
    applicationId: IDS.applicationId,
    roundId: IDS.roundId,
    runtimeSessionId: IDS.runtimeSessionId,
    attempt: 1,
    revision: 2,
    eventId: 'e'.repeat(64),
    digest: 'f'.repeat(64),
    allowUnboundRuntimeSession: true,
    persistReservation: vi.fn().mockResolvedValue(null),
    ...overrides,
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('Hire ingestion revision reservation', () => {
  it('rejects an older revision without invoking the event writer', async () => {
    installAtomicRound({
      runtimeSessionId: new mongoose.Types.ObjectId(IDS.runtimeSessionId),
      attempt: 1,
      revision: 3,
      eventId: '1'.repeat(64),
      digest: '2'.repeat(64),
      status: 'processed',
    })
    const request = input()

    await expect(reserveHireRoundIngestion(request)).resolves.toEqual({
      outcome: 'stale',
    })
    expect(request.persistReservation).not.toHaveBeenCalled()
  })

  it('orders attempt before revision and rejects an older attempt without writes', async () => {
    installAtomicRound({
      runtimeSessionId: new mongoose.Types.ObjectId(IDS.runtimeSessionId),
      attempt: 2,
      revision: 1,
      eventId: '1'.repeat(64),
      digest: '2'.repeat(64),
      status: 'processed',
    })
    const request = input({ attempt: 1, revision: 10 })

    await expect(reserveHireRoundIngestion(request)).resolves.toEqual({
      outcome: 'stale',
    })
    expect(request.persistReservation).not.toHaveBeenCalled()
  })

  it('advances a later attempt even when its revision restarts at one', async () => {
    installAtomicRound({
      runtimeSessionId: new mongoose.Types.ObjectId(IDS.runtimeSessionId),
      attempt: 1,
      revision: 10,
      eventId: '1'.repeat(64),
      digest: '2'.repeat(64),
      status: 'processed',
    })
    const request = input({ attempt: 2, revision: 1 })

    await expect(reserveHireRoundIngestion(request)).resolves.toMatchObject({
      outcome: 'acquired',
    })
    expect(request.persistReservation).toHaveBeenCalledOnce()
  })

  it('serializes concurrent conflicting content before either loser can persist', async () => {
    installAtomicRound()
    let releaseFirst!: () => void
    const firstEntered = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let signalFirst!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      signalFirst = resolve
    })
    const first = input({
      persistReservation: vi.fn(async () => {
        signalFirst()
        await firstEntered
        return null
      }),
    })
    const second = input({
      eventId: '3'.repeat(64),
      digest: '4'.repeat(64),
    })

    const firstPromise = reserveHireRoundIngestion(first)
    await firstStarted
    await expect(reserveHireRoundIngestion(second)).resolves.toMatchObject({
      outcome: 'conflict',
    })
    expect(second.persistReservation).not.toHaveBeenCalled()
    releaseFirst()
    await expect(firstPromise).resolves.toMatchObject({ outcome: 'acquired' })
  })

  it('rolls back a lazy legacy duplicate instead of committing a new head', async () => {
    const state = installAtomicRound()
    const request = input({
      persistReservation: vi.fn().mockResolvedValue('duplicate'),
    })

    await expect(reserveHireRoundIngestion(request)).resolves.toEqual({
      outcome: 'duplicate',
    })
    expect(state.read()).toBeUndefined()
  })

  it('reclassifies a concurrent unique-event race in a fresh transaction', async () => {
    const state = installAtomicRound()
    const duplicateKey = Object.assign(new Error('event id raced'), {
      code: 11000,
    })
    const request = input({
      persistReservation: vi
        .fn()
        .mockRejectedValueOnce(duplicateKey)
        .mockResolvedValueOnce('duplicate'),
    })

    await expect(reserveHireRoundIngestion(request)).resolves.toEqual({
      outcome: 'duplicate',
    })
    expect(request.persistReservation).toHaveBeenCalledTimes(2)
    expect(state.read()).toBeUndefined()
  })

  it('allows only the exact expired event to reclaim a crashed reservation', async () => {
    const now = new Date('2026-08-21T00:00:00.000Z')
    installAtomicRound({
      runtimeSessionId: new mongoose.Types.ObjectId(IDS.runtimeSessionId),
      attempt: 1,
      revision: 2,
      eventId: 'e'.repeat(64),
      digest: 'f'.repeat(64),
      status: 'reserved',
      reservationToken: 'old-owner',
      leaseExpiresAt: new Date(now.getTime() - 1),
    })
    const request = input({ now })

    await expect(reserveHireRoundIngestion(request)).resolves.toMatchObject({
      outcome: 'acquired',
    })
    expect(request.persistReservation).toHaveBeenCalledOnce()
  })

  it('classifies an active exact retry as in progress', () => {
    expect(
      __hireIngestionRevisionReservation.classifyExistingReservation(
        {
          runtimeSessionId: new mongoose.Types.ObjectId(IDS.runtimeSessionId),
          attempt: 1,
          revision: 2,
          eventId: 'e'.repeat(64),
          digest: 'f'.repeat(64),
          status: 'reserved',
        },
        input(),
      ),
    ).toEqual({ outcome: 'in_progress' })
  })

  it('preserves a terminal stale outcome across a lost acknowledgement', () => {
    expect(
      __hireIngestionRevisionReservation.classifyExistingReservation(
        {
          runtimeSessionId: new mongoose.Types.ObjectId(IDS.runtimeSessionId),
          attempt: 1,
          revision: 2,
          eventId: 'e'.repeat(64),
          digest: 'f'.repeat(64),
          status: 'processed',
          terminalOutcome: 'stale',
        },
        input(),
      ),
    ).toEqual({ outcome: 'stale' })
  })
})
