import mongoose from 'mongoose'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { HireEngineIngestionEvent } from '../models/HireEngineIngestionEvent'
import { HireRound } from '../models/HireRound'
import {
  completeHireRoundIngestion,
  reserveHireRoundIngestion,
} from '../services/ingestionRevisionReservationService'

const uri = process.env.HIRE_INGESTION_REPLICA_SET_TEST_URI
const database = process.env.HIRE_INGESTION_REPLICA_SET_TEST_DATABASE
const enabled = process.env.HIRE_INGESTION_REPLICA_SET_TEST === '1'

if (enabled && (!uri || !database)) {
  throw new Error(
    'HIRE_INGESTION_REPLICA_SET_TEST_URI and HIRE_INGESTION_REPLICA_SET_TEST_DATABASE are required when the replica-set gate is enabled',
  )
}

const replicaSuite = describe.skipIf(!enabled)

replicaSuite('Hire ingestion reservation on a real replica set', () => {
  const ids = {
    workspaceId: new mongoose.Types.ObjectId(),
    applicationId: new mongoose.Types.ObjectId(),
    jobId: new mongoose.Types.ObjectId(),
    candidateId: new mongoose.Types.ObjectId(),
    roundId: new mongoose.Types.ObjectId(),
    runtimeSessionId: new mongoose.Types.ObjectId(),
  }

  beforeAll(async () => {
    if (!database?.endsWith('_test')) {
      throw new Error('replica-set integration database must end with _test')
    }
    await mongoose.connect(uri as string, {
      dbName: database,
      autoIndex: false,
    })
    await HireEngineIngestionEvent.collection.createIndex(
      { roundId: 1, runtimeSessionId: 1, attempt: 1, revision: 1 },
      {
        name: 'roundId_1_runtimeSessionId_1_attempt_1_revision_1',
        unique: true,
      },
    )
    await HireRound.collection.insertOne({
      _id: ids.roundId,
      workspaceId: ids.workspaceId,
      applicationId: ids.applicationId,
      jobId: ids.jobId,
      candidateId: ids.candidateId,
      runtimeSessionId: ids.runtimeSessionId,
      status: 'processing',
    })
  })

  afterAll(async () => {
    if (mongoose.connection.readyState === 1) {
      await Promise.all([
        HireEngineIngestionEvent.deleteMany({ roundId: ids.roundId }),
        HireRound.deleteOne({ _id: ids.roundId }),
      ])
      await mongoose.disconnect()
    }
  })

  it(
    'elects one concurrent writer and rejects an older attempt without a ledger write',
    async () => {
      const persist = (eventId: string, digest: string) =>
        vi.fn(async (session: mongoose.ClientSession) => {
          await HireEngineIngestionEvent.create(
            [
              {
                eventId,
                workspaceId: ids.workspaceId,
                applicationId: ids.applicationId,
                roundId: ids.roundId,
                runtimeSessionId: ids.runtimeSessionId,
                attempt: 2,
                revision: 1,
                resultDigest: digest,
                media: [],
                status: 'received',
              },
            ],
            { session },
          )
          return null
        })
      const firstEvent = 'a'.repeat(64)
      const firstDigest = 'b'.repeat(64)
      const secondEvent = 'c'.repeat(64)
      const secondDigest = 'd'.repeat(64)
      const firstPersist = persist(firstEvent, firstDigest)
      const secondPersist = persist(secondEvent, secondDigest)
      const common = {
        stream: 'engineResult' as const,
        workspaceId: ids.workspaceId.toString(),
        applicationId: ids.applicationId.toString(),
        roundId: ids.roundId.toString(),
        runtimeSessionId: ids.runtimeSessionId.toString(),
        attempt: 2,
        revision: 1,
        allowUnboundRuntimeSession: false,
      }

      const decisions = await Promise.all([
        reserveHireRoundIngestion({
          ...common,
          eventId: firstEvent,
          digest: firstDigest,
          persistReservation: firstPersist,
        }),
        reserveHireRoundIngestion({
          ...common,
          eventId: secondEvent,
          digest: secondDigest,
          persistReservation: secondPersist,
        }),
      ])
      const winner = decisions.find(
        (decision) => decision.outcome === 'acquired',
      )
      expect(winner?.outcome).toBe('acquired')
      expect(
        decisions.some(
          (decision) =>
            decision.outcome === 'conflict' ||
            decision.outcome === 'in_progress',
        ),
      ).toBe(true)
      expect(await HireEngineIngestionEvent.countDocuments({ roundId: ids.roundId })).toBe(1)

      const winnerIsFirst = decisions[0].outcome === 'acquired'
      const eventId = winnerIsFirst ? firstEvent : secondEvent
      const digest = winnerIsFirst ? firstDigest : secondDigest
      const session = await mongoose.startSession()
      try {
        await session.withTransaction(async () => {
          await completeHireRoundIngestion({
            ...common,
            eventId,
            digest,
            reservationToken: (
              decisions[winnerIsFirst ? 0 : 1] as {
                outcome: 'acquired'
                reservationToken: string
              }
            ).reservationToken,
            terminalOutcome: 'processed',
            session,
          })
        })
      } finally {
        await session.endSession()
      }

      const stalePersist = vi.fn().mockResolvedValue(null)
      await expect(
        reserveHireRoundIngestion({
          ...common,
          attempt: 1,
          revision: 10,
          eventId: 'e'.repeat(64),
          digest: 'f'.repeat(64),
          persistReservation: stalePersist,
        }),
      ).resolves.toEqual({ outcome: 'stale' })
      expect(stalePersist).not.toHaveBeenCalled()
      expect(await HireEngineIngestionEvent.countDocuments({ roundId: ids.roundId })).toBe(1)
    },
    30_000,
  )
})
