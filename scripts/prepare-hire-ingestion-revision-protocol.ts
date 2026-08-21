#!/usr/bin/env tsx
/**
 * Attempt-aware Hire ingestion cutover. This is intentionally a drain-only
 * migration: deploy the v2 route in `draining` mode, wait six minutes, run
 * --apply on each isolated Hire surface, then enable `required` mode.
 *
 * It never calls syncIndexes. Old unique indexes are dropped only after their
 * replacements have been built and verified.
 */
import { pathToFileURL } from 'node:url'
import mongoose from 'mongoose'
import {
  HIRE_INGESTION_REVISION_DRAIN_MS,
  HIRE_INGESTION_REVISION_PROTOCOL_VERSION,
  evaluateHireIngestionRevisionProtocol,
} from '../shared/contracts/hireIngestionRevisionProtocol'
import { deploymentSurfaceIdentity } from '../shared/surfaces/deploymentSurfaceIdentity'
import { connectDB } from '../shared/db/connection'
import { HireInterviewAttempt } from '../modules/hire/models/HireInterviewAttempt'
import { HireEngineIngestionEvent } from '../modules/hire/models/HireEngineIngestionEvent'
import { HireMediaAsset } from '../modules/hire/models/HireMediaAsset'
import {
  HireMultimodalAnalysis,
  HireMultimodalAnalysisIngestionEvent,
} from '../modules/hire-multimodal/models'
import { HireRuntimeMultimodalAnalysisOutbox } from '../modules/hire-runtime/models/HireRuntimeMultimodalAnalysisOutbox'

type Mode = 'plan' | 'check' | 'apply'
type Surface = 'hire-control' | 'hire-engine'
type IndexKey = Readonly<Record<string, 1 | -1>>

interface IndexDefinition {
  collection: {
    createIndex(
      key: IndexKey,
      options: {
        name: string
        unique: true
        partialFilterExpression?: Record<string, unknown>
      },
    ): Promise<string>
    dropIndex(name: string): Promise<unknown>
    indexes(): Promise<Array<{
      name?: string
      key?: Record<string, unknown>
      unique?: boolean
      partialFilterExpression?: unknown
    }>>
  }
  label: string
  name: string
  key: IndexKey
  legacyName?: string
  partialFilterExpression?: Record<string, unknown>
}

export function hireIngestionRevisionPreparationMode(argv: string[]): Mode {
  if (argv.length === 0) return 'plan'
  if (argv.length === 1 && argv[0] === '--check') return 'check'
  if (argv.length === 1 && argv[0] === '--apply') return 'apply'
  throw new Error('usage: [--check | --apply]')
}

export function assertHireIngestionRevisionMigrationWindow(input: {
  environment: NodeJS.ProcessEnv
  now?: Date
}): void {
  if (input.environment.HIRE_INGESTION_REVISION_PROTOCOL_MODE !== 'draining') {
    throw new Error(
      'set HIRE_INGESTION_REVISION_PROTOCOL_MODE=draining before migration',
    )
  }
  const raw =
    input.environment.HIRE_INGESTION_REVISION_PROTOCOL_DRAIN_STARTED_AT
  const startedAt = raw ? new Date(raw) : undefined
  const now = input.now ?? new Date()
  if (
    !startedAt ||
    !Number.isFinite(startedAt.getTime()) ||
    startedAt.getTime() > now.getTime() - HIRE_INGESTION_REVISION_DRAIN_MS
  ) {
    throw new Error(
      `the ingestion drain must remain closed for at least ${HIRE_INGESTION_REVISION_DRAIN_MS}ms`,
    )
  }
}

export function hireIngestionRevisionMigrationSurface(
  environment: NodeJS.ProcessEnv,
): Surface {
  const identity = deploymentSurfaceIdentity(environment)
  if (identity.configurationIssue || identity.surface === 'b2c') {
    throw new Error('IPG_SURFACE must be hire-control or hire-engine')
  }
  return identity.surface
}

function assertExpectedDatabase(target: Surface): void {
  const expected =
    target === 'hire-control'
      ? process.env.HIRE_CONTROL_DATABASE_NAME?.trim()
      : process.env.HIRE_RUNTIME_DATABASE_NAME?.trim()
  if (!expected || mongoose.connection.name !== expected) {
    throw new Error('connected database is not the configured Hire surface')
  }
}

function controlIndexes(): IndexDefinition[] {
  return [
    {
      collection: HireEngineIngestionEvent.collection,
      label: 'engine ingestion events',
      name: 'roundId_1_runtimeSessionId_1_attempt_1_revision_1',
      key: { roundId: 1, runtimeSessionId: 1, attempt: 1, revision: 1 },
      legacyName: 'roundId_1_runtimeSessionId_1_revision_1',
    },
    {
      collection: HireMultimodalAnalysisIngestionEvent.collection,
      label: 'analysis ingestion events',
      name: 'workspaceId_1_roundId_1_runtimeSessionId_1_attempt_1_revision_1',
      key: {
        workspaceId: 1,
        roundId: 1,
        runtimeSessionId: 1,
        attempt: 1,
        revision: 1,
      },
      legacyName: 'workspaceId_1_roundId_1_runtimeSessionId_1_revision_1',
    },
    {
      collection: HireMultimodalAnalysis.collection,
      label: 'multimodal analyses',
      name:
        'workspaceId_1_applicationId_1_roundId_1_attemptId_1_runtimeSessionId_1_revision_1',
      key: {
        workspaceId: 1,
        applicationId: 1,
        roundId: 1,
        attemptId: 1,
        runtimeSessionId: 1,
        revision: 1,
      },
      legacyName:
        'workspaceId_1_applicationId_1_roundId_1_runtimeSessionId_1_revision_1',
    },
    {
      collection: HireMediaAsset.collection,
      label: 'runtime media checkpoints',
      name: 'ingestionCheckpointKey_1_ingestionCheckpointGeneration_1',
      key: { ingestionCheckpointKey: 1, ingestionCheckpointGeneration: 1 },
      partialFilterExpression: {
        ingestionCheckpointKey: { $type: 'string' },
        ingestionCheckpointGeneration: { $type: 'number' },
      },
    },
  ]
}

function runtimeIndexes(): IndexDefinition[] {
  return [
    {
      collection: HireRuntimeMultimodalAnalysisOutbox.collection,
      label: 'runtime analysis outbox',
      name: 'workspaceId_1_roundId_1_runtimeSessionId_1_attempt_1_revision_1',
      key: {
        workspaceId: 1,
        roundId: 1,
        runtimeSessionId: 1,
        attempt: 1,
        revision: 1,
      },
      legacyName: 'workspaceId_1_roundId_1_runtimeSessionId_1_revision_1',
    },
  ]
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

async function hasExactIndex(definition: IndexDefinition): Promise<boolean> {
  const indexes = await definition.collection.indexes()
  return indexes.some(
    (index) =>
      index.name === definition.name &&
      index.unique === true &&
      sameJson(index.key, definition.key) &&
      sameJson(
        index.partialFilterExpression,
        definition.partialFilterExpression,
      ),
  )
}

async function assertNoAttemptBackfillGaps(): Promise<void> {
  const [engineMissing, analysisMissing] = await Promise.all([
    HireEngineIngestionEvent.countDocuments({ attempt: { $exists: false } }),
    HireMultimodalAnalysisIngestionEvent.countDocuments({
      attempt: { $exists: false },
    }),
  ])
  if (engineMissing || analysisMissing) {
    throw new Error(
      `attempt backfill incomplete (engine=${engineMissing}, analysis=${analysisMissing})`,
    )
  }
}

async function backfillControlLedgers(): Promise<void> {
  const missing = HireMultimodalAnalysisIngestionEvent.find({
    attempt: { $exists: false },
  }).cursor()
  for await (const event of missing) {
    const analysis = await HireMultimodalAnalysis.findOne({
      eventId: event.eventId,
      workspaceId: event.workspaceId,
      applicationId: event.applicationId,
      roundId: event.roundId,
      runtimeSessionId: event.runtimeSessionId,
      revision: event.revision,
    })
      .select('attemptId')
      .lean()
    if (!analysis) {
      if (event.status !== 'received') {
        throw new Error(`processed analysis event ${event.eventId} has no analysis`)
      }
      await HireMultimodalAnalysisIngestionEvent.deleteOne({
        _id: event._id,
        status: 'received',
        attempt: { $exists: false },
      })
      continue
    }
    const attempt = await HireInterviewAttempt.findOne({
      _id: analysis.attemptId,
      workspaceId: event.workspaceId,
      applicationId: event.applicationId,
      roundId: event.roundId,
    })
      .select('sequence')
      .lean()
    if (!attempt) {
      throw new Error(`analysis event ${event.eventId} has no interview attempt`)
    }
    await HireMultimodalAnalysisIngestionEvent.updateOne(
      { _id: event._id, attempt: { $exists: false } },
      { $set: { attempt: attempt.sequence } },
    )
  }
  await Promise.all([
    HireEngineIngestionEvent.updateMany(
      { status: 'processed', terminalOutcome: { $exists: false } },
      { $set: { terminalOutcome: 'processed' } },
    ),
    HireMultimodalAnalysisIngestionEvent.updateMany(
      { status: 'processed', terminalOutcome: { $exists: false } },
      { $set: { terminalOutcome: 'processed' } },
    ),
  ])
  await assertNoAttemptBackfillGaps()
}

async function createAndSwapIndexes(
  definitions: IndexDefinition[],
): Promise<void> {
  for (const definition of definitions) {
    if (!(await hasExactIndex(definition))) {
      await definition.collection.createIndex(definition.key, {
        name: definition.name,
        unique: true,
        ...(definition.partialFilterExpression
          ? { partialFilterExpression: definition.partialFilterExpression }
          : {}),
      })
    }
    if (!(await hasExactIndex(definition))) {
      throw new Error(`failed to verify ${definition.label} v2 index`)
    }
    if (definition.legacyName && definition.legacyName !== definition.name) {
      const indexes = await definition.collection.indexes()
      if (indexes.some((index) => index.name === definition.legacyName)) {
        await definition.collection.dropIndex(definition.legacyName)
      }
    }
  }
}

async function checkIndexes(definitions: IndexDefinition[]): Promise<void> {
  for (const definition of definitions) {
    if (!(await hasExactIndex(definition))) {
      throw new Error(`missing exact v2 index for ${definition.label}`)
    }
    console.log(`✓ ${definition.label}: ${definition.name}`)
  }
}

export async function prepareHireIngestionRevisionProtocol(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const mode = hireIngestionRevisionPreparationMode(argv)
  if (mode === 'plan') {
    console.log(
      `Hire ingestion revision protocol v${HIRE_INGESTION_REVISION_PROTOCOL_VERSION}: deploy draining, wait ${HIRE_INGESTION_REVISION_DRAIN_MS}ms, --apply control/engine, then enable required`,
    )
    return
  }
  const target = hireIngestionRevisionMigrationSurface(process.env)
  if (mode === 'apply') {
    assertHireIngestionRevisionMigrationWindow({ environment: process.env })
  } else if (process.env.HIRE_INGESTION_REVISION_PROTOCOL_MODE === 'required') {
    const decision = evaluateHireIngestionRevisionProtocol({
      requestVersion: HIRE_INGESTION_REVISION_PROTOCOL_VERSION,
    })
    if (!decision.ok) throw new Error(`invalid required-mode gate: ${decision.reason}`)
  }
  await connectDB({ schemaInitialization: 'disabled' })
  assertExpectedDatabase(target)
  const definitions =
    target === 'hire-control' ? controlIndexes() : runtimeIndexes()
  if (mode === 'apply') {
    if (target === 'hire-control') await backfillControlLedgers()
    await createAndSwapIndexes(definitions)
  }
  if (target === 'hire-control') await assertNoAttemptBackfillGaps()
  await checkIndexes(definitions)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareHireIngestionRevisionProtocol().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
