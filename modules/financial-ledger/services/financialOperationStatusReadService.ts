import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import {
  FinancialOperationIntent,
  type FinancialOperationFinalResult,
  type FinancialOperationIntentOperation,
  type FinancialOperationIntentStatus,
  type FinancialProviderObservationOutcome,
} from '../models/FinancialOperationIntent'
import type { FinancialLedgerProviderMode } from '../types'
const OBJECT_ID = /^[a-f0-9]{24}$/i
const DIGEST = /^[a-f0-9]{64}$/
const READ_MAX_TIME_MS = 1_000
const RECOVERY_READ_MAX_TIME_MS = 750
const RECOVERY_READ_LIMIT_MAX = 100
const STATUS_PROJECTION = [
  'status operation providerMode requestDigest requestedAt approval.approvedAt',
  'approval.approvalDigest',
  'claim.fencingToken claim.claimedAt claim.leaseExpiresAt',
  'observations.outcome observations.evidenceDigest observations.attestationDigest',
  'observations.commandDigest observations.observationDigest',
  'observations.observedAt observations.verifiedAt observations.fencingToken',
  'observationVersion finalization.observationDigest finalization.result',
  'finalization.resultDigest finalization.localEffectAttestationDigest',
  'finalization.commandDigest finalization.verifiedAt finalization.finalizedAt',
  'finalization.finalizationDigest',
  'createdAt updatedAt',
].join(' ')
export class FinancialOperationStatusQueryError extends Error {
  constructor() {
    super('Invalid financial operation intent id')
    this.name = 'FinancialOperationStatusQueryError'
  }
}
export class FinancialOperationStatusNotFoundError extends Error {
  constructor() {
    super('Financial operation intent not found')
    this.name = 'FinancialOperationStatusNotFoundError'
  }
}
export class FinancialOperationRecoveryQueryError extends Error {
  constructor(
    message = 'Invalid financial operation recovery query',
  ) {
    super(message)
    this.name = 'FinancialOperationRecoveryQueryError'
  }
}
export function parseFinancialOperationIntentId(input: unknown): string {
  if (
    typeof input !== 'string' ||
    input.length !== 24 ||
    !OBJECT_ID.test(input)
  ) {
    throw new FinancialOperationStatusQueryError()
  }
  return input.toLowerCase()
}
interface StatusRow {
  _id: mongoose.Types.ObjectId
  status: FinancialOperationIntentStatus
  operation: FinancialOperationIntentOperation
  providerMode: FinancialLedgerProviderMode
  requestDigest: string
  requestedAt: Date
  approval?: { approvedAt: Date; approvalDigest: string }
  claim?: {
    fencingToken: number
    claimedAt: Date
    leaseExpiresAt: Date
  }
  observations: Array<{
    outcome: FinancialProviderObservationOutcome
    evidenceDigest: string
    attestationDigest: string
    commandDigest: string
    observationDigest: string
    observedAt: Date
    verifiedAt: Date
    fencingToken: number
  }>
  observationVersion: number
  finalization?: {
    observationDigest: string
    result: FinancialOperationFinalResult
    resultDigest: string
    localEffectAttestationDigest: string
    commandDigest: string
    verifiedAt: Date
    finalizedAt: Date
    finalizationDigest: string
  }
  createdAt: Date
  updatedAt: Date
}

interface DueRefundOperationRow {
  _id: mongoose.Types.ObjectId
  providerMode: FinancialLedgerProviderMode
  requestDigest: string
}

function recoveryReadLimit(input: unknown): number {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    Object.keys(input).length !== 1 ||
    !Object.hasOwn(input, 'limit')
  ) {
    throw new FinancialOperationRecoveryQueryError()
  }
  const limit = (input as { limit?: unknown }).limit
  if (
    !Number.isSafeInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > RECOVERY_READ_LIMIT_MAX
  ) {
    throw new FinancialOperationRecoveryQueryError()
  }
  return limit as number
}

/**
 * Read-only liveness scan for the refund recovery worker. Provider authority
 * and mutable intent operations remain behind the private payments adapter.
 */
export async function readDueRefundOperationRecoveryCandidates(
  input: unknown,
) {
  const limit = recoveryReadLimit(input)
  await connectDB()
  const now = new Date()
  const rows = await FinancialOperationIntent.find({
    operation: 'refund',
    $or: [
      { status: 'approved' },
      {
        status: { $in: ['claimed', 'provider_uncertain'] },
        'claim.leaseExpiresAt': { $lte: now },
      },
    ],
  })
    .select('_id providerMode requestDigest')
    .sort({ _id: 1 })
    .limit(limit)
    .maxTimeMS(RECOVERY_READ_MAX_TIME_MS)
    .lean<DueRefundOperationRow[]>()
    .exec()
  return Object.freeze(rows.map((row) => {
    const intentId = row._id.toHexString().toLowerCase()
    if (
      !OBJECT_ID.test(intentId) ||
      !['test', 'live'].includes(row.providerMode) ||
      !DIGEST.test(row.requestDigest)
    ) {
      throw new FinancialOperationRecoveryQueryError(
        'Refund recovery sweep found malformed intent evidence',
      )
    }
    return Object.freeze({
      providerMode: row.providerMode,
      intentId,
      requestDigest: row.requestDigest,
    })
  }))
}

export async function readFinancialOperationStatus(
  input: unknown,
) {
  const id = parseFinancialOperationIntentId(input)
  await connectDB()
  const row = await FinancialOperationIntent.findById(
    new mongoose.Types.ObjectId(id),
  )
    .select(STATUS_PROJECTION)
    .maxTimeMS(READ_MAX_TIME_MS)
    .lean<StatusRow>()
    .exec()
  if (!row) throw new FinancialOperationStatusNotFoundError()
  return {
    readAt: new Date().toISOString(),
    intentId: row._id.toHexString(),
    status: row.status,
    operation: row.operation,
    providerMode: row.providerMode,
    requestDigest: row.requestDigest,
    requestedAt: row.requestedAt.toISOString(),
    approval: row.approval
      ? {
          approvedAt: row.approval.approvedAt.toISOString(),
          approvalDigest: row.approval.approvalDigest,
        }
      : null,
    claim: row.claim
      ? {
          fencingToken: row.claim.fencingToken,
          claimedAt: row.claim.claimedAt.toISOString(),
          leaseExpiresAt: row.claim.leaseExpiresAt.toISOString(),
        }
      : null,
    observations: row.observations.map((entry) => ({
      outcome: entry.outcome,
      evidenceDigest: entry.evidenceDigest,
      attestationDigest: entry.attestationDigest,
      commandDigest: entry.commandDigest,
      observationDigest: entry.observationDigest,
      observedAt: entry.observedAt.toISOString(),
      verifiedAt: entry.verifiedAt.toISOString(),
      fencingToken: entry.fencingToken,
    })),
    observationVersion: row.observationVersion,
    finalization: row.finalization
      ? {
          observationDigest: row.finalization.observationDigest,
          result: row.finalization.result,
          resultDigest: row.finalization.resultDigest,
          localEffectAttestationDigest:
            row.finalization.localEffectAttestationDigest,
          commandDigest: row.finalization.commandDigest,
          verifiedAt: row.finalization.verifiedAt.toISOString(),
          finalizedAt: row.finalization.finalizedAt.toISOString(),
          finalizationDigest: row.finalization.finalizationDigest,
        }
      : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    permissions: { canMutate: false as const },
  }
}
